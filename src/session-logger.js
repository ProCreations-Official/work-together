import fs from 'fs-extra';
import path from 'path';
import { format } from 'date-fns';

export class SessionLogger {
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE;
    this.baseDir = path.join(home, '.work-together', 'logs');
  }

  async start(sessionId) {
    await fs.ensureDir(this.baseDir);
    const timestamp = format(new Date(), 'yyyy-MM-dd-HHmmss');
    this.filePath = path.join(this.baseDir, `session-${timestamp}-${sessionId}.log`);
    await fs.writeFile(this.filePath, `# Session ${sessionId} started at ${new Date().toISOString()}\n`, 'utf8');
  }

  async record(update) {
    if (!this.filePath) return;
    const line = `${new Date().toISOString()} ${JSON.stringify(update)}\n`;
    await fs.appendFile(this.filePath, line, 'utf8');
  }

  async finish(summary) {
    if (!this.filePath) return;
    await fs.appendFile(this.filePath, `# Session finished\n${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
}
