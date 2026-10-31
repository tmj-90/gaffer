Recorded shapes of the GitHub CLI's JSON output (gh 2.89.0), for the CI gate's contract
test (`runner/test/ci-gate-gh-contract.test.sh`):

- `pr-checks-fields.txt` — the JSON FIELDS `gh pr checks --help` lists (the CLI refuses
  any other field with `Unknown JSON field: "<name>"`).
- `pr-view-fields.txt` — the JSON FIELDS `gh pr view --help` lists.
- `pr-checks-*.json` — `gh pr checks <branch> --json bucket,completedAt,description,event,link,name,startedAt,state,workflow`
  for a green, a red, a running and a cancelled run (values anonymised).
