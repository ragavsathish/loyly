import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { metrics } from '@opentelemetry/api';

const endpoint = process.env.OTLP_RECEIVER;
if (!endpoint || !process.env.CANDIDATE_SHA256 || !process.env.PROBE_RUN_ID)
  throw new Error('missing telemetry probe binding');
let bookings;
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'loyly-booking-candidate',
    'candidate.sha256': process.env.CANDIDATE_SHA256,
    'probe.run_id': process.env.PROBE_RUN_ID,
    'process.pid': process.pid,
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReaders: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 1000,
  })],
  instrumentations: [new HttpInstrumentation({
    requestHook: (_span, request) => {
      if (request.method === 'POST' && request.url === '/api/bookings')
        bookings?.add(1, { 'http.request.method': 'POST', 'http.route': '/api/bookings' });
    },
  })],
});
sdk.start();
bookings = metrics.getMeter('loyly-panel').createCounter('loyly.booking.request',
  { description: 'Instrumented candidate booking requests', unit: '{request}' });
