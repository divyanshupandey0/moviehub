import assert from "node:assert/strict";
import {
  getTodayDateString,
  isValidReleasedTVShow,
  filterReleasedTV,
  filterAndSortRecentTV,
} from "../dist/index.js";

console.log("=== RUNNING STRICT TV RELEASE-DATE FILTERING TESTS ===");

const today = getTodayDateString();
console.log(`Current evaluated date (today): ${today}`);

// Test 1: A TV show that premiered in the past — should appear.
const pastShow = {
  id: 101,
  name: "Past Released Series",
  poster_path: "/past.jpg",
  first_air_date: "2026-10-15",
  status: "Returning Series",
};
assert.equal(
  isValidReleasedTVShow(pastShow, today),
  true,
  "Test 1 FAILED: Past premiered show must be valid",
);
console.log("✔ Test 1 PASSED: Past premiered TV show appears as valid/released.");

// Test 2: A TV show with a future "first_air_date" — must NOT appear.
const futureShow = {
  id: 102,
  name: "Future Upcoming Series",
  poster_path: "/future.jpg",
  first_air_date: "2027-01-20",
  status: "Planned",
};
assert.equal(
  isValidReleasedTVShow(futureShow, today),
  false,
  "Test 2 FAILED: Future show must NOT be valid",
);
console.log("✔ Test 2 PASSED: TV show with future first_air_date is strictly excluded.");

// Test 3: A TV show with a missing or invalid date — must NOT appear in release-based sections.
const missingDateShow = {
  id: 103,
  name: "Missing Date Series",
  poster_path: "/missing.jpg",
  first_air_date: "",
};
const nullDateShow = {
  id: 104,
  name: "Null Date Series",
  poster_path: "/null.jpg",
  first_air_date: null,
};
const invalidDateShow = {
  id: 105,
  name: "Invalid Date Series",
  poster_path: "/invalid.jpg",
  first_air_date: "TBD",
};
assert.equal(isValidReleasedTVShow(missingDateShow, today), false);
assert.equal(isValidReleasedTVShow(nullDateShow, today), false);
assert.equal(isValidReleasedTVShow(invalidDateShow, today), false);
console.log("✔ Test 3 PASSED: TV shows with missing/null/invalid dates are strictly excluded.");

// Test 4: An old popular show — must NOT appear as a recent release.
const mixedList = [
  { id: 201, name: "Old Classic Series (2015)", poster_path: "/old.jpg", first_air_date: "2015-04-12" },
  { id: 202, name: "Recent Show 1", poster_path: "/rec1.jpg", first_air_date: "2026-10-20" },
  { id: 203, name: "Future Show (2027)", poster_path: "/fut.jpg", first_air_date: "2027-05-01" },
  { id: 204, name: "Recent Show 2 (Today)", poster_path: "/rec2.jpg", first_air_date: today },
  { id: 205, name: "No Date Series", poster_path: "/nodate.jpg" },
];

const filtered = filterReleasedTV(mixedList, today);
assert.equal(filtered.some((s) => s.id === 203), false, "Future show leaked into filtered list!");
assert.equal(filtered.some((s) => s.id === 205), false, "No-date show leaked into filtered list!");

// Recent added list should be sorted newest first:
const sortedRecent = filterAndSortRecentTV(mixedList, today);
assert.equal(sortedRecent[0].id, 204, "Today's show should be at the very top (newest first)");
assert.equal(sortedRecent[1].id, 202, "Oct 20 show should be second");
console.log("✔ Test 4 & 5 PASSED: Correct sorting (newest first) and unreleased completely filtered out.");

// Test 6: Verify cache re-filtration:
// Even if stale cached data contained unreleased items, filtering at retrieval cleans it:
const cachedPayload = {
  results: [
    { id: 991, name: "Cached Future Show", poster_path: "/f.jpg", first_air_date: "2028-09-01" },
    { id: 992, name: "Cached Valid Show", poster_path: "/v.jpg", first_air_date: "2026-10-25" },
  ]
};
const cleanedCache = filterReleasedTV(cachedPayload.results, today);
assert.equal(cleanedCache.length, 1);
assert.equal(cleanedCache[0].id, 992);
console.log("✔ Test 6 PASSED: Cache re-filtration successfully strips stale future items.");

console.log("\nALL TV RELEASE FILTERING TESTS COMPLETED SUCCESSFULLY!");
