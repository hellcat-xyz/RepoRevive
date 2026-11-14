---
inclusion: always
---

# Maintainability Rules

- Specs live in `.kiro/specs/<feature>/{requirements,design,tasks}.md`. Update the spec before
  changing behaviour it describes; tick tasks as they complete.
- Repair strategies are small, independent modules: one file per strategy family, each exporting
  objects that implement `FixStrategy`. A strategy declares which issue kinds it handles.
- Every new issue kind needs: a diagnoser rule, a human explanation in the report, and a test.
- Database changes go through Prisma migrations (`npm run db:migrate`). Never edit applied
  migrations.
- Configuration is centralised in `src/server/config.ts` (zod-validated env). Document new env vars
  in `.env.example` and the README.
- Keep the README's "Running locally" section working; it is the onboarding contract.
