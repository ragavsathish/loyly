// One job: compile and apply the approved Allure lifecycle schema.
import { Ajv2020 } from "ajv/dist/2020.js";

export type AllureSchemaValidator = (
  result: unknown,
  fileHint?: string,
) => void;

/** Compile `allure-lifecycle-result.schema.json` once; reuse across results. */
export function compileAllureSchema(schema: object): AllureSchemaValidator {
  const validate = new Ajv2020({ strict: false }).compile(schema);
  return (result, fileHint = "result") => {
    if (!validate(result))
      throw new Error(
        `Allure schema rejected ${fileHint}: ${JSON.stringify(validate.errors)}`,
      );
  };
}
