'use strict';
// Which rating a game counts towards. The category comes from the clock: the base time plus
// 40 increments, which is how most chess sites decide it.
//   under 3 minutes  -> bullet      (1+0)
//   under 8 minutes  -> blitz       (3+0, 3+2, 5+0, 5+3)
//   8 minutes or more -> rapid      (10+0, 15+10)
const CATEGORIES = ['bullet', 'blitz', 'rapid'];

function categoryOf(baseSeconds, incSeconds) {
  const estimate = baseSeconds + 40 * incSeconds;
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  return 'rapid';
}

// "5+3" -> 'blitz'
function categoryOfTc(tc) {
  const m = /^(\d+)\+(\d+)$/.exec(String(tc));
  return m ? categoryOf(Number(m[1]) * 60, Number(m[2])) : 'blitz';
}

module.exports = { CATEGORIES, categoryOf, categoryOfTc };
