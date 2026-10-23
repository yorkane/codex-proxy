import { expect, test } from "bun:test";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_ENV,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
  modelRequestMaxAttempts,
  modelRequestMaxRetries,
} from "../../src/lib/model-request-retry";

const ENV = MODEL_REQUEST_MAX_RETRIES_ENV;

test("model-request retry budget defaults to the mandated ten retries", () => {
  expect(modelRequestMaxRetries(undefined, {})).toBe(10);
  expect(DEFAULT_MODEL_REQUEST_MAX_RETRIES).toBe(10);
  expect(MODEL_REQUEST_MAX_RETRIES_LIMIT).toBe(100);
  // The requirement is "at least 10": the total send budget is the retries plus the first send.
  expect(modelRequestMaxAttempts(undefined, {})).toBe(11);
});

test("model-request retry budget floors every value below ten", () => {
  for (const configured of [0, 1, 5, 9, -1, -1000, 0.5]) {
    expect(modelRequestMaxRetries(configured, {})).toBe(10);
  }
  // A parsable env value below the floor is an instruction to retry, not an off switch, and a
  // negative one is floored the same way: no caller can resolve fewer than 10 retries.
  for (const raw of ["0", "5", "9", "-1", "-1000"]) {
    expect(modelRequestMaxRetries(50, { [ENV]: raw })).toBe(10);
  }
});

test("model-request retry budget clamps above the ceiling and floors fractions", () => {
  expect(modelRequestMaxRetries(500, {})).toBe(100);
  expect(modelRequestMaxRetries(100, {})).toBe(100);
  expect(modelRequestMaxRetries(37.9, {})).toBe(37);
  expect(modelRequestMaxRetries(10.5, {})).toBe(10);
  expect(modelRequestMaxRetries(500, { [ENV]: "1000" })).toBe(100);
  expect(modelRequestMaxRetries(undefined, { [ENV]: "25.9" })).toBe(25);
});

test("model-request retry budget prefers env over config and ignores an empty env", () => {
  expect(modelRequestMaxRetries(20, { [ENV]: "40" })).toBe(40);
  expect(modelRequestMaxRetries(20, { [ENV]: "10" })).toBe(10);
  for (const blank of ["", "   ", "\t"]) {
    expect(modelRequestMaxRetries(20, { [ENV]: blank })).toBe(20);
  }
});

test("model-request retry budget falls back instead of disabling on unparseable input", () => {
  // A non-empty env value that is not a number is not a switch: it falls to the configured
  // value, then to the default. A malformed environment must never take the protection away.
  for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "1e", "12x"]) {
    expect(modelRequestMaxRetries(30, { [ENV]: raw })).toBe(30);
    expect(modelRequestMaxRetries(undefined, { [ENV]: raw })).toBe(10);
  }
  for (const configured of [NaN, Infinity, -Infinity]) {
    expect(modelRequestMaxRetries(configured, {})).toBe(10);
  }
});

test("model-request attempts is exactly one more than the resolved retries", () => {
  for (const [configured, env] of [
    [undefined, {}],
    [20, {}],
    [0, {}],
    [500, {}],
    [50, { [ENV]: "12" }],
    [30, { [ENV]: "zzz" }],
  ] as Array<[number | undefined, Record<string, string>]>) {
    expect(modelRequestMaxAttempts(configured, env)).toBe(modelRequestMaxRetries(configured, env) + 1);
  }
  expect(modelRequestMaxAttempts(0, {})).toBe(11);
  expect(modelRequestMaxAttempts(999, {})).toBe(101);
});
