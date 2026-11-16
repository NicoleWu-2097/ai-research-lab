import { expect, it } from "vitest";
import { commandSuffix } from "../src/commands.js";
it("completes only command prefixes, leaving arguments and normal messages untouched", () => {
  expect(commandSuffix("/op")).toBe("en");
  expect(commandSuffix("/open")).toBe("");
  expect(commandSuffix("/open pr")).toBe("");
  expect(commandSuffix("研究一下")).toBe("");
  expect(commandSuffix("/unknown")).toBe("");
});
