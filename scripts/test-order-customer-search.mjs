import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderCustomerSearchClauses, orderCustomerMatchesSearch } from "../src/utils/orderCustomerSearch.ts";

test("customer names match accents, case, partial names and whitespace", () => {
  for (const query of ["minh sĩ", "minh si", "SĨ", "  minh   si "]) {
    assert.equal(orderCustomerMatchesSearch(["minh sĩ"], query), true, query);
    assert.ok(buildOrderCustomerSearchClauses(query).some((clause) => clause.customerName?.test("minh sĩ")));
  }
  assert.equal(orderCustomerMatchesSearch(["Khách khác"], "minh si"), false);
});
test("phone numbers match formatting, fragments and +84", () => {
  for (const query of ["0985059073", "0985 059 073", "+84 985 059 073", "059073"]) {
    assert.equal(orderCustomerMatchesSearch(["0985.059.073"], query), true, query);
    for (const field of ["customerPhone", "data.customerPhone", "data.recipient_address.phone"]) {
      assert.ok(buildOrderCustomerSearchClauses(query).some((clause) => clause[field]?.test("0985.059.073")), query + ": " + field);
    }
  }
});
test("search input is treated as literal text", () => {
  for (const query of ["[a]", ".*", "(minh)"]) {
    assert.ok(!buildOrderCustomerSearchClauses(query).some((clause) => clause.customerName?.test("unrelated")));
  }
});
