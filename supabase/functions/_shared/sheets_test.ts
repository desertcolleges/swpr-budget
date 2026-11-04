import { parseSheet } from "./sheets.ts";

const columns = ["institution", "round", "project", "object_category", "expenditure_amount"];
function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}
function rejects(values: unknown[][], message: string) {
  try {
    parseSheet(values);
  } catch (error) {
    assert(error instanceof Error && error.message.includes(message));
    return;
  }
  throw new Error("Expected import rejection");
}

Deno.test("normalizes cumulative totals without inventing activity expenditures", () => {
  const rows = parseSheet([columns, ["College", "r10", "Project R10", "1000", 123.45],
    ["College", "R10", "Project R10", "6000s", -12], ["", "", "", "", ""]]);
  assert(rows.length === 2 && rows[0].round === "R10" && rows[0].object_category === "1000s");
  assert(rows[0].expenditure_amount === 123.45 && rows[1].expenditure_amount === -12);
});
Deno.test("rejects empty, malformed and duplicate snapshots", () => {
  rejects([columns], "no expenditure");
  rejects([columns, ["", "", "", "", ""]], "Empty");
  rejects([columns, ["College", "R10", "Project", "7000", 5]], "row 2");
  rejects([columns, ["College", "R10", "Project", "1000", "$1,000"]], "row 2");
  rejects([columns, ["College", "R10", "Project", "1000", "1.123"]], "row 2");
  rejects([columns, ["College", "R10", "Project", "1000", "NaN"]], "row 2");
  rejects([columns, ["College", "R10", "Project", "1000", 10],
    ["college", "r10", "project", "1000s", 20]], "Duplicate");
  rejects([["institution", "round", "project", "object_category", "object_category"], ["a"]], "exactly one");
});
