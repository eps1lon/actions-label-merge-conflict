# Contributing

## Pull Requests

You don't need to open an issue first but if you don't please explain the problem (current behavior, expected behavior etc.).
Please target the latest version of the default branch.

### Continious Integration

Before we can merge a PR all GitHub checks need to be green.

#### GitHub actions

Check out `.github/workflows/ci.yml` to understand why a certain task is failing. You can read the logs of a failed build to find out which task (and probably why it) failed.
The build of every PR must be checked in (`yarn build` and commit) so that tests can run against the PR.
