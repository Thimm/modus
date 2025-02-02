import debug from 'debug';
import { execaCommand } from 'execa';
import fs from 'fs/promises';
import chalk from 'chalk';

const { green, red } = chalk;
const info = debug('@modusjs/cli#test:info');
const test = (msg: string) => info(green(msg));

async function passthru(command: string) {
  info('Running command: ', command);
  const ps = execaCommand(command);
  if (ps.stdout) ps.stdout.pipe(process.stdout);
  if (ps.stderr) ps.stderr.pipe(process.stderr);
  return ps; // Promise<string>
}


export default async function run() {
  info('copying assets from examples');
  await fs.cp('../examples/examples/tomkat-historic/tomkat_source_data2015_RMN0-10cm_1.json', './test-work/tomkat2015_1.json');
  await fs.cp('../examples/examples/tomkat-historic/tomkat_source_data2015_RMN0-10cm_2.json', './test-work/tomkat2015_2.json');

  test('tohtml tomkat2015_1.json tomkat2015_2.json');
  await passthru('yarn tohtml ./test-work/tomkat2015_1.json ./test-work/tomkat2015_2.json');
  
  test('tohtml results exist and are not empty');
  const result1 = (await fs.readFile('./test-work/tomkat2015_1.html')).toString();
  const result2 = (await fs.readFile('./test-work/tomkat2015_2.html')).toString();
  if (result1.length < 0) {
    throw new Error(`ouput file of tohtml ./test-work/tomkat2015_1.html is empty or does not exist`);
  }
  if (result2.length < 0) {
    throw new Error(`ouput file of tohtml ./test-work/tomkat2015_2.html is empty or does not exist`);
  }
  
  test('tohtml All tests passed');
}



function deepdiff(a: any, b: any, path?: string, differences?: string[]): string[] {
  if (!differences) differences = [];
  path = path || '';

  // Same type:
  if (typeof a !== typeof b) {
    differences.push(`a is a ${typeof a} but b is a ${typeof b} at path ${path}`);
    return differences;
  }

  // they are the same at this point if they are not an object
  if (typeof a !== 'object') {
    return differences;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    differences.push(`isArray(a) is ${Array.isArray(a)}, but isArray(b) is ${Array.isArray(b)} at path ${path}`);
    return differences;
  }

  // They both have keys/values, so compare them
  for (const [key, value] of Object.entries(a)) {
    differences = deepdiff(value, b[key], `${path}/${key}`, differences);
  }

  return differences;
}
