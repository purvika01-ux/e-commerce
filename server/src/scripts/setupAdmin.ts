import { randomBytes } from 'node:crypto';
import { hashPassword } from '../security/passwords';

/**
 * Prints the admin login settings for server/.env (or the host's environment settings).
 * The password is typed without echo and is never printed — only its scrypt hash is.
 * Usage: npm run setup-admin [-- --username alice]
 */

function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped input (e.g. CI): read one line.
    return new Promise((resolve) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    });
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const i = process.argv.indexOf('--username');
  const username = i > -1 ? process.argv[i + 1] : 'admin';
  if (!username || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    console.error('Username must be 3–64 letters, digits, dot, dash or underscore.');
    process.exit(1);
  }
  const password = await readHidden('New admin password (min 12 characters): ');
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const again = await readHidden('Repeat password: ');
    if (again !== password) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }
  console.log('\nAdd these lines to server/.env (or your host\'s environment settings), then restart the server:\n');
  console.log(`ADMIN_USERNAME=${username}`);
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
  console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
  console.log('\nKeep these out of Git. Changing SESSION_SECRET signs everyone out.');
}

void main();
