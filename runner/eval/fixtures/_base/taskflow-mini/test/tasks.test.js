import test from "node:test";
import assert from "node:assert/strict";
import { addTask, completeTask } from "../src/tasks.js";

test("addTask appends", () => {
  assert.equal(addTask([], "a").length, 1);
});

test("completeTask marks done", () => {
  assert.equal(completeTask(addTask([], "a"), "a")[0].done, true);
});
