export function addTask(list, title) {
  return [...list, { title, done: false }];
}

export function completeTask(list, title) {
  return list.map((t) => (t.title === title ? { ...t, done: true } : t));
}
