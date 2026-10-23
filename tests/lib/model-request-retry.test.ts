import { expect, test } from "bun:test";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_ENV,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
  MODEL_REQUEST_MAX_RETRIES_MIN,
  modelRequestMaxAttempts,
  modelRequestMaxRetries,
  modelRequestRetryEnvOverride,
} from "../../src/lib/model-request-retry";

const ENV = MODEL_REQUEST_MAX_RETRIES_ENV;

test("model-request retry budget defaults to the mandated three retries in 0-5", () => {
  expect(modelRequestMaxRetries(undefined, {})).toBe(3);
  expect(DEFAULT_MODEL_REQUEST_MAX_RETRIES).toBe(3);
  expect(MODEL_REQUEST_MAX_RETRIES_MIN).toBe(0);
  expect(MODEL_REQUEST_MAX_RETRIES_LIMIT).toBe(5);
  // The send budget is the retries plus the first send.
  expect(modelRequestMaxAttempts(undefined, {})).toBe(4);
});

test("model-request retry budget honours zero as the off switch", () => {
  // 0 is a configured value, never a falsy fallback to 3: config 0 and env "0" both resolve
  // to zero retries, and the send budget is the single first send.
  expect(modelRequestMaxRetries(0, {})).toBe(0);
  expect(modelRequestMaxRetries(3, { [ENV]: "0" })).toBe(0);
  expect(modelRequestMaxAttempts(0, {})).toBe(1);
});

test("model-request retry budget clamps parsed env values into 0-5", () => {
  // Env is the operator's explicit instruction: a parsed number floors fractions and clamps
  // into range (a legacy 10 becomes 5, negatives become 0).
  expect(modelRequestMaxRetries(3, { [ENV]: "10" })).toBe(5);
  expect(modelRequestMaxRetries(3, { [ENV]: "999" })).toBe(5);
  expect(modelRequestMaxRetries(3, { [ENV]: "-1" })).toBe(0);
  expect(modelRequestMaxRetries(3, { [ENV]: "4.9" })).toBe(4);
  expect(modelRequestMaxRetries(3, { [ENV]: "5" })).toBe(5);
});

test("model-request retry budget treats an out-of-range configured value as unset, not clamped", () => {
  // The config side never clamps: a hand-edited legacy 10, a 6, a fraction, a negative, a
  // non-finite number all resolve to the default 3, exactly like the load schema degrading
  // them to absent. Clamping 10 to 5 here would make the management DTO (which passes the
  // raw configured value through) disagree with loadConfig (schema -> absent -> 3).
  for (const configured of [10, 6, 100, 999, -1, -1000, 1.5, 3.9, NaN, Infinity, -Infinity]) {
    expect(modelRequestMaxRetries(configured, {})).toBe(3);
  }
  // In-range integers are honoured verbatim, including 0.
  for (const configured of [0, 1, 2, 3, 4, 5]) {
    expect(modelRequestMaxRetries(configured, {})).toBe(configured);
  }
});

test("model-request retry budget prefers env over config and ignores an empty env", () => {
  expect(modelRequestMaxRetries(1, { [ENV]: "4" })).toBe(4);
  expect(modelRequestMaxRetries(1, { [ENV]: "0" })).toBe(0);
  for (const blank of ["", "   ", "\t"]) {
    expect(modelRequestMaxRetries(2, { [ENV]: blank })).toBe(2);
  }
});

test("model-request retry budget falls back instead of disabling on unparseable input", () => {
  // A non-empty env value that is not a number is not a switch: it falls to the configured
  // value, then to the default. A malformed environment must not take the protection away
  // (and must not manufacture one where the operator asked for none).
  for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "1e", "12x"]) {
    expect(modelRequestMaxRetries(1, { [ENV]: raw })).toBe(1);
    expect(modelRequestMaxRetries(undefined, { [ENV]: raw })).toBe(3);
  }
});

test("env-override flag is true only for a non-blank finite number", () => {
  expect(modelRequestRetryEnvOverride({})).toBe(false);
  for (const blank of ["", "   ", "\t"]) {
    expect(modelRequestRetryEnvOverride({ [ENV]: blank })).toBe(false);
  }
  for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "12x"]) {
    expect(modelRequestRetryEnvOverride({ [ENV]: raw })).toBe(false);
  }
  // Clamped values are still the operator's explicit instruction.
  for (const raw of ["0", "3", "5", "10", "-1", "4.9"]) {
    expect(modelRequestRetryEnvOverride({ [ENV]: raw })).toBe(true);
  }
});

test("model-request attempts is exactly one more than the resolved retries", () => {
  for (const [configured, env] of [
    [undefined, {}],
    [0, {}],
    [5, {}],
    [10, {}],
    [3, { [ENV]: "0" }],
    [1, { [ENV]: "10" }],
    [2, { [ENV]: "zzz" }],
  ] as Array<[number | undefined, Record<string, string>]>) {
    expect(modelRequestMaxAttempts(configured, env)).toBe(modelRequestMaxRetries(configured, env) + 1);
  }
  expect(modelRequestMaxAttempts(0, {})).toBe(1);
  expect(modelRequestMaxAttempts(3, { [ENV]: "10" })).toBe(6);
});
