#!/usr/bin/env node
// Compute the Q-factor / agentic-coding static metrics for harness sources.
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PI = resolve(HERE, '..');
const ROOTS = [PI, resolve(PI, '../cycle-core'), resolve(PI, '../evidence-core')].filter(existsSync);
const SKIP = new Set(['node_modules', 'scratch', 'reviews', 'fixture', 'test', 'dist', '.git']);
const HIGH_CC = 10;

const COMPLEXITY_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.') continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP.has(name) || name.startsWith('scratch')) continue;
      walk(path, out);
    } else if (['.ts', '.mjs', '.js'].includes(extname(name)) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function complexityOf(node) {
  let complexity = 1;
  const visit = (n) => {
    if (COMPLEXITY_KINDS.has(n.kind)) {
      if (n.kind === ts.SyntaxKind.BinaryExpression) {
        const op = n.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          complexity++;
      } else complexity++;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return complexity;
}

function nestingDepth(node) {
  let max = 0;
  const visit = (n, depth) => {
    // Only count control structures, not every block, to match typical nesting metrics.
    const bump =
      ts.isIfStatement(n) ||
      ts.isForStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isTryStatement(n) ||
      ts.isSwitchStatement(n) ||
      ts.isCatchClause(n)
        ? 1
        : 0;
    const next = depth + bump;
    if (bump) max = Math.max(max, next);
    ts.forEachChild(n, (child) => visit(child, next));
  };
  visit(node, 0);
  return max;
}

function functionName(node, sourceFile) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  )
    return node.name?.getText(sourceFile) ?? '<anonymous>';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText(sourceFile);
    if (ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(sourceFile);
  }
  return '<anonymous>';
}

function countSymbols(sourceFile) {
  let count = 0;
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    )
      count++;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function lineCount(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

function codeLines(text) {
  let blank = 0;
  let comments = 0;
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      blank++;
      continue;
    }
    if (inBlock) {
      comments++;
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      comments++;
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) comments++;
  }
  return Math.max(0, lineCount(text) - blank - comments);
}

const files = ROOTS.flatMap((root) => walk(root));
const functions = [];
let totalLoc = 0;
let totalCode = 0;
let totalSymbols = 0;
const importGraph = new Map(); // file -> Set of resolved local deps

for (const path of files) {
  const text = readFileSync(path, 'utf8');
  totalLoc += lineCount(text);
  totalCode += codeLines(text);
  const kind =
    path.endsWith('.ts') || path.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  totalSymbols += countSymbols(sf);

  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node);
    if (isFn && node.body) {
      functions.push({
        file: relative(PI, path),
        name: functionName(node, sf),
        cc: complexityOf(node),
        loc: lineCount(node.getText(sf)),
        nesting: nestingDepth(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const deps = new Set();
  for (const stmt of sf.statements) {
    let spec = null;
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier))
      spec = stmt.moduleSpecifier.text;
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    )
      spec = stmt.moduleSpecifier.text;
    if (!spec || !spec.startsWith('.')) continue;
    const candidates = [
      resolve(dirname(path), spec),
      resolve(dirname(path), spec + '.ts'),
      resolve(dirname(path), spec + '.mjs'),
      resolve(dirname(path), spec + '.js'),
      resolve(dirname(path), spec, 'index.ts'),
    ];
    for (const c of candidates) if (existsSync(c) && files.includes(c)) deps.add(c);
  }
  importGraph.set(path, deps);
}

// Shannon entropy of out-degree distribution (normalized to [0,1] by log2(n)).
const degrees = [...importGraph.values()].map((d) => d.size);
const degreeCounts = new Map();
for (const d of degrees) degreeCounts.set(d, (degreeCounts.get(d) ?? 0) + 1);
const n = degrees.length || 1;
let entropy = 0;
for (const count of degreeCounts.values()) {
  const p = count / n;
  entropy -= p * Math.log2(p);
}
const maxEntropy = Math.log2(Math.max(2, degreeCounts.size));
const graphDependencyEntropy = maxEntropy === 0 ? 0 : entropy / maxEntropy;

const ccs = functions.map((f) => f.cc);
const locs = functions.map((f) => f.loc);
const nestings = functions.map((f) => f.nesting);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

const ccMax = ccs.length ? Math.max(...ccs) : 0;
const ccMean = mean(ccs);
const meanFuncLoc = mean(locs);
const linesPerSymbol = totalSymbols ? totalLoc / totalSymbols : 0;
const ccNormalized = totalCode ? sum(ccs) / totalCode : 0;
const highCcPct = functions.length
  ? (100 * functions.filter((f) => f.cc >= HIGH_CC).length) / functions.length
  : 0;
const maxNestingDepth = nestings.length ? Math.max(...nestings) : 0;

// cloned_pct via jscpd JSON if present / fresh run
const jscpdOut = join(PI, 'scratch-jscpd');
mkdirSync(jscpdOut, { recursive: true });
spawnSync(
  join(PI, 'node_modules/.bin/jscpd'),
  [
    '--config',
    join(PI, '.jscpd.json'),
    '--output',
    jscpdOut,
    '--silent',
    '.',
    '../cycle-core',
    '../evidence-core',
  ],
  { cwd: PI, encoding: 'utf8' },
);
let clonedPct = null;
const reportPath = join(jscpdOut, 'jscpd-report.json');
if (existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  clonedPct = report.statistics?.total?.percentage ?? null;
}

// violation_pct: eslint problems / files analyzed
const eslint = spawnSync(
  join(PI, 'node_modules/.bin/eslint'),
  ['.', '--format', 'json', '--no-error-on-unmatched-pattern'],
  { cwd: PI, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);
let violationPct;
try {
  const results = JSON.parse(eslint.stdout || '[]');
  const eslintFiles = results.length;
  const eslintViolating = results.filter(
    (r) => (r.errorCount ?? 0) + (r.warningCount ?? 0) > 0,
  ).length;
  violationPct = eslintFiles ? (100 * eslintViolating) / eslintFiles : 0;
} catch {
  violationPct = null;
}

const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));

const metrics = {
  generatedAt: new Date().toISOString(),
  scope: ROOTS.map((r) => relative(resolve(PI, '../..'), r)),
  population: {
    files: files.length,
    functions: functions.length,
    loc: totalLoc,
    codeLines: totalCode,
    symbols: totalSymbols,
    highCcThreshold: HIGH_CC,
  },
  metrics: {
    cc_max: ccMax,
    cloned_pct: round(clonedPct, 2),
    graph_dependency_entropy: round(graphDependencyEntropy, 3),
    mean_func_loc: round(meanFuncLoc, 2),
    lines_per_symbol: round(linesPerSymbol, 2),
    cc_normalized: round(ccNormalized, 4),
    high_cc_pct: round(highCcPct, 2),
    violation_pct: round(violationPct, 2),
    cc_mean: round(ccMean, 2),
    max_nesting_depth: maxNestingDepth,
  },
  definitions: {
    cc_max: 'Maximum McCabe cyclomatic complexity of any function',
    cloned_pct: 'jscpd duplicated-line percentage over harness TS/JS sources',
    graph_dependency_entropy:
      'Normalized Shannon entropy of local import out-degree distribution [0,1]',
    mean_func_loc: 'Mean source lines per function body',
    lines_per_symbol: 'Total LOC / declared symbols (fns, classes, types, vars)',
    cc_normalized: 'Sum(function CC) / code lines (complexity density)',
    high_cc_pct: `% of functions with CC ≥ ${HIGH_CC}`,
    violation_pct: '% of ESLint-analyzed files with ≥1 error or warning',
    cc_mean: 'Mean function cyclomatic complexity',
    max_nesting_depth: 'Maximum control-structure nesting depth in any function',
  },
  topComplex: [...functions]
    .sort((a, b) => b.cc - a.cc || b.loc - a.loc)
    .slice(0, 10)
    .map(({ file, name, cc, loc, nesting }) => ({ file, name, cc, loc, nesting })),
};

const outDir = join(PI, 'scratch-metrics');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'metrics.json');
writeFileSync(outFile, `${JSON.stringify(metrics, null, 2)}\n`);

const rows = Object.entries(metrics.metrics);
console.log(`scope: ${metrics.scope.join(', ')}`);
console.log(
  `files=${metrics.population.files} functions=${metrics.population.functions} loc=${metrics.population.loc}`,
);
console.log('');
for (const [key, value] of rows) {
  console.log(`${key.padEnd(28)} ${value}`);
}
console.log(`\nwrote ${relative(PI, outFile)}`);
