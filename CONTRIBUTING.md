# Contributing to SafeHarbor

SafeHarbor is a parental-controls project, so changes should prioritize child safety, parent clarity, privacy, and honest security boundaries.

## Development

1. Use Node.js 20 LTS or newer.
2. Run the local server with:

   ```sh
   npm start
   ```

3. Run syntax checks before submitting changes:

   ```sh
   npm run check
   ```

## Contribution Guidelines

- Keep secrets, tokens, local captures, and private browsing data out of commits.
- Prefer focused pull requests with clear behavior changes.
- Add tests when changing shared policy logic, API behavior, browser enforcement, sync, or reporting.
- Document security limitations honestly. Do not imply SafeHarbor is tamper-proof.
- Minimize collected browsing content by default. Prefer metadata and aggregate reporting unless a feature explicitly needs more detail.

## Public Discussion

Do not post real child browsing data, tokens, logs, or device identifiers in issues, pull requests, discussions, or screenshots.

