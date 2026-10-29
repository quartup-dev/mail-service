import { writeFile } from 'node:fs/promises';
import packageJson from '../package.json' with { type: 'json' };
import { generateOpenApiYaml } from '../src/interfaces/http/openapi-document';

// Genera openapi.yaml desde las rutas, sin servicios externos ni variables de entorno
await writeFile('openapi.yaml', await generateOpenApiYaml(packageJson.version));
console.log('openapi.yaml generated');
