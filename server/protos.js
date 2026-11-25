// Loads the .proto files with protobufjs. `long` is installed so 64-bit
// Steam IDs keep full precision (they are passed around as strings).
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import Long from "long";

protobuf.util.Long = Long;
protobuf.configure();

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "proto");

const rust = protobuf.loadSync(path.join(dir, "rustplus.proto"));
const push = protobuf.loadSync(path.join(dir, "push.proto"));

export const R = {
  AppRequest: rust.lookupType("rustplus.AppRequest"),
  AppMessage: rust.lookupType("rustplus.AppMessage"),
};

export const P = {
  AndroidCheckinRequest: push.lookupType("push.AndroidCheckinRequest"),
  AndroidCheckinResponse: push.lookupType("push.AndroidCheckinResponse"),
  LoginRequest: push.lookupType("push.LoginRequest"),
  LoginResponse: push.lookupType("push.LoginResponse"),
  Heartbeat: push.lookupType("push.Heartbeat"),
  DataMessageStanza: push.lookupType("push.DataMessageStanza"),
};

/** Plain JS object: 64-bit ints as strings, enums as numbers, bytes as base64. */
export const TO_OBJECT = { longs: String, enums: Number, bytes: String, arrays: true };

export function encode(type, obj) {
  return type.encode(type.fromObject(obj)).finish();
}

export function decode(type, buf) {
  return type.toObject(type.decode(buf), TO_OBJECT);
}
