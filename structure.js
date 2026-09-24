import fs from 'fs';
import path from 'path';

const FILE_COMMENTS = {
  'backend': 'Express Proxy & Gemini AI Backend Service',
  'backend/api': 'Vercel Serverless Function Handlers',
  'backend/api/index.js': 'Vercel express serverless handler',
  'client': 'React Frontend Application Workspace',
  'client/public': 'Public static assets',
  'client/src': 'Frontend source code',
  'client/src/components': 'UI Components & Layout Elements',
  'client/src/hooks': 'Custom React Hooks',

  'backend/package.json': 'Backend NPM dependencies & start scripts',
  'backend/server.js': '🚀 Main Express Server & Gemini Proxy API',
  'client/src/hooks/useIframeBridge.ts': 'PostMessage handler to sync iframe navigation',
  'client/src/App.tsx': 'Main Chat & Web Navigator UI Container',
  'client/src/main.tsx': 'React DOM bootstrap entrypoint',
  'client/index.html': 'HTML Shell for Vite React App',
  'client/package.json': 'Frontend NPM dependencies & build scripts',
  'client/tsconfig.json': 'TypeScript compiler configurations',
  'client/vite.config.ts': 'Vite dev server & API proxy settings',
  '.gitignore': 'Root git ignore file for sensitive files and node_modules',
  'setup.ps1': 'Automated PowerShell setup script',
  'structure.js': 'Project structure generator script',
  'vercel.json': 'Vercel monorepo deployment & routing rules'
};

const IGNORED = new Set([
  'node_modules',
  '.next',
  '.git',
  '.vscode',
  '.idea',
  'dist',
  'build',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.env',
  '.env.local',
  '.env.development',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'generate-tree.js',
  'structure.txt'
]);

function generateTree(dir, prefix = '', relativeDir = '', depthLevel = 1) {
  let output = '';

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => !IGNORED.has(item.name))
      .sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));

    items.forEach((item, index) => {
      const isLast = index === items.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const icon = item.isDirectory() ? '📁 ' : '📄 ';
      
      const itemRelativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
      const lineContent = `${prefix}${connector}${icon}${item.name}`;
      
      const comment = FILE_COMMENTS[itemRelativePath];
      
      // Only attach comments if depth is 3 or more indents deep AND a comment exists
      if (comment && depthLevel >= 3) {
        output += `${lineContent}    # ${comment}\n`;
      } else {
        output += `${lineContent}\n`;
      }

      if (item.isDirectory()) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        // Recursively increment depthLevel
        output += generateTree(path.join(dir, item.name), newPrefix, itemRelativePath, depthLevel + 1);
      }
    });
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
  }

  return output;
}

const rootName = path.basename(process.cwd());
const treeText = `${rootName}/\n` + generateTree(process.cwd());

fs.writeFileSync('structure.txt', treeText, 'utf8');
console.log('✅ Clean project structure generated! Comments enabled for items 3+ indents deep.');