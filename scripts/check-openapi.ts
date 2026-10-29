import packageJson from '../package.json' with { type: 'json' };
import { checkOpenApiFile } from './lib/openapi-check';

const problems = await checkOpenApiFile('openapi.yaml', packageJson.version);
for (const problem of problems) console.error(problem);
if (problems.length === 0) console.log('openapi.yaml is up to date and valid');
process.exitCode = problems.length === 0 ? 0 : 1;
