// Lookup tables read with a key the page does not control: a status, a reason code, a
// view name from the address bar. A plain object literal answers such a key through its
// prototype too, so MAP["constructor"] is a function, not "no entry", and a label lookup
// that falls back with `||` renders a function (the Team sheet threw on a ticket whose
// reason code was "constructor"). A table has no prototype: a key it was not given reads
// undefined, whatever the key is. Entries can still be added (table({}) then t[k] = v).

/** A copy of `entries` with no prototype. Read it with any key. */
export function table(entries) {
  return Object.assign(Object.create(null), entries);
}
