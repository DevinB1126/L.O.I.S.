// Unit tests for the buffered NDJSON parser used to reconstruct Ollama
// streaming responses. Uses Node's built-in test runner (node:test) so no
// new test framework dependency is introduced.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { NdjsonBuffer, NdjsonParseError } from "./ndjsonParser";

test("CASE 1: one complete JSON record in one chunk", () => {
  const buf = new NdjsonBuffer();
  const records = buf.push('{"response":"hello"}\n');

  assert.equal(records.length, 1);
  assert.equal(records[0].response, "hello");
});

test("CASE 2: multiple complete JSON records in one chunk", () => {
  const buf = new NdjsonBuffer();
  const records = buf.push('{"response":"hel"}\n{"response":"lo"}\n{"response":" world"}\n');

  assert.deepEqual(
    records.map((r) => r.response),
    ["hel", "lo", " world"]
  );
});

test("CASE 3: one JSON record split across two chunks", () => {
  const buf = new NdjsonBuffer();

  const first = buf.push('{"respon');
  assert.equal(first.length, 0, "no complete record yet");

  const second = buf.push('se":"hello"}\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].response, "hello");
});

test("CASE 4: multiple records split across several arbitrary chunks", () => {
  const buf = new NdjsonBuffer();

  const chunks = ['{"resp', 'onse":"hel', 'lo"}\n{"resp', 'onse":" wor', 'ld"}\n'];
  const results: string[] = [];

  for (const chunk of chunks) {
    for (const record of buf.push(chunk)) {
      if (typeof record.response === "string") results.push(record.response);
    }
  }

  assert.deepEqual(results, ["hello", " world"]);
});

test("CASE 5: blank lines between records are ignored", () => {
  const buf = new NdjsonBuffer();
  const records = buf.push('{"response":"a"}\n\n\n{"response":"b"}\n');

  assert.deepEqual(
    records.map((r) => r.response),
    ["a", "b"]
  );
});

test("CASE 6: final record with no trailing newline is recovered on flush", () => {
  const buf = new NdjsonBuffer();

  const midStream = buf.push('{"response":"a"}\n{"response":"b"}');
  assert.deepEqual(
    midStream.map((r) => r.response),
    ["a"],
    "the unterminated second record is not emitted yet"
  );

  const flushed = buf.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].response, "b");
});

test("CASE 6b: final record WITH a trailing newline is not duplicated on flush", () => {
  const buf = new NdjsonBuffer();
  buf.push('{"response":"a"}\n');

  const flushed = buf.flush();
  assert.equal(flushed.length, 0, "nothing left to flush once the line was already terminated");
});

test("CASE 7: malformed JSON record raises NdjsonParseError instead of being swallowed", () => {
  const buf = new NdjsonBuffer();

  assert.throws(() => {
    buf.push('{"response":"ok"}\n{not valid json}\n');
  }, NdjsonParseError);
});

test("CASE 7b: malformed trailing record on flush also raises, not swallowed", () => {
  const buf = new NdjsonBuffer();
  buf.push('{"response":"ok"}\n');
  buf.push("{still not json");

  assert.throws(() => buf.flush(), NdjsonParseError);
});

test("CASE 8: record containing done:true is parsed like any other record", () => {
  const buf = new NdjsonBuffer();
  const records = buf.push(
    '{"response":"final chunk"}\n{"model":"llama3.1","done":true,"total_duration":123}\n'
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].response, "final chunk");
  assert.equal(records[1].done, true);
  assert.equal(records[1].response, undefined);
});

test("CASE 9: multi-byte unicode text split across chunks decodes correctly", () => {
  // Simulates the caller decoding raw bytes with TextDecoder({stream:true})
  // before handing text to the buffer — here we just confirm the buffer
  // correctly reassembles a JSON record whose *text content* arrives in
  // fragments that don't align with the record boundary.
  const buf = new NdjsonBuffer();
  const full = '{"response":"café 🚀"}\n';

  const mid = Math.floor(full.length / 2);
  const first = buf.push(full.slice(0, mid));
  const second = buf.push(full.slice(mid));

  const records = [...first, ...second];
  assert.equal(records.length, 1);
  assert.equal(records[0].response, "café 🚀");
});

test("error record is preserved on the object (caller decides how to surface it)", () => {
  const buf = new NdjsonBuffer();
  const records = buf.push('{"error":"model not found"}\n');

  assert.equal(records.length, 1);
  assert.equal(records[0].error, "model not found");
});
