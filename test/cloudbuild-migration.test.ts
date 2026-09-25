import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import YAML from 'yaml';

it('runs a pinned migration job before deploying the service', async () => {
  const config = YAML.parse(await readFile(new URL('../cloudbuild.yaml', import.meta.url), 'utf8')) as {
    steps: Array<{ id: string; args: string[] }>;
  };
  expect(config.steps.map((step) => step.id)).toEqual(['build', 'push', 'migrate-job', 'migrate', 'deploy']);
  const [build, push, job, migrate, deploy] = config.steps;
  const image = 'asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$COMMIT_SHA';
  for (const step of [build, push, job, deploy]) expect(step!.args).toContain(image);
  expect(job!.args).toContain('et-mig-$BUILD_ID');
  expect(migrate!.args).toContain('et-mig-$BUILD_ID');
  expect(migrate!.args).toContain('--wait');
  expect(job!.args).toContain('PGPASSWORD=echotrail-db-password:latest');
  expect(deploy!.args).toContain('PGPASSWORD=echotrail-db-password:latest');
  expect(job!.args).toContain('echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com');
  expect(job!.args).toContain('--set-cloudsql-instances');
  expect(job!.args).toContain('dist/migrate.js');
  expect(job!.args).toContain('--max-retries');
  expect(job!.args).toContain('0');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  expect(dockerfile).toContain('COPY migrations ./migrations');
});
