// scripts/update-skill.js
// Execution: node scripts/update-skill.js
// This script automatically scans the codebase and updates the project skill context.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SKILL_FILE_RELATIVE = '.gemini/skills/voice-translate.md';
const SKILL_FILE_PATH = path.join(ROOT_DIR, SKILL_FILE_RELATIVE);
const ROOT_SKILL_FILE_PATH = path.join(ROOT_DIR, 'project_skill.md');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const INIT_DB_PATH = path.join(ROOT_DIR, 'scripts/init-db.js');

// 1. Scan directory structure to generate tree (ignoring unneeded directories/files)
function generateFileTree(dir, prefix = '', isLast = true) {
  const dirName = path.basename(dir);
  
  const ignoreList = ['.git', '.next', 'node_modules', '.vercel', '.env.local', 'tmp-next-dev.out.log', 'tmp-next-dev.err.log', 'Screenshot 2026-03-31 150239.png'];
  if (ignoreList.includes(dirName)) {
    return '';
  }

  let result = '';
  const isRoot = dir === ROOT_DIR;
  
  if (!isRoot) {
    result += `${prefix}${isLast ? '└── ' : '├── '}${dirName}${fs.statSync(dir).isDirectory() ? '/' : ''}\n`;
  } else {
    result += 'Chinese-translation_1/\n';
  }

  const stat = fs.statSync(dir);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(dir)
      .filter(file => !ignoreList.includes(file))
      .sort((a, b) => {
        // Folders first, then files
        const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(dir, file);
      const isLastChild = i === files.length - 1;
      const nextPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
      result += generateFileTree(filePath, nextPrefix, isLastChild);
    }
  }
  
  return result;
}

// 2. Extract dependencies from package.json and format as a Markdown table
function getDependenciesMarkdown() {
  if (!fs.existsSync(PACKAGE_JSON_PATH)) {
    return '*(package.json not found)*';
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};
    
    // Mapping commonly used packages to their English roles
    const roleMap = {
      'next': 'Full-stack framework (App Router)',
      'react': 'UI library',
      'react-dom': 'UI DOM renderer',
      '@vercel/postgres': 'User translation and history database',
      'microsoft-cognitiveservices-speech-sdk': 'Microsoft Azure Speech SDK support (extended)',
      'dotenv': 'Environment variable management',
      'eslint': 'Syntax linting and code style checker',
      'eslint-config-next': 'Standard Next.js eslint config',
      'babel-plugin-react-compiler': 'React 19 compiler for performance optimizations'
    };

    let md = '| Library | Version | Role in Project |\n';
    md += '|---------|---------|-----------------|\n';
    
    const allDeps = { ...deps, ...devDeps };
    
    for (const [name, version] of Object.entries(allDeps)) {
      const role = roleMap[name] || 'Supporting library';
      md += `| \`${name}\` | \`${version}\` | ${role} |\n`;
    }
    
    return md;
  } catch (error) {
    console.error('❌ Error parsing package.json:', error.message);
    return '*(Error parsing package.json)*';
  }
}

// 3. Extract SQL Database Schema from scripts/init-db.js
function getDatabaseSchemaMarkdown() {
  if (!fs.existsSync(INIT_DB_PATH)) {
    return '*(scripts/init-db.js not found)*';
  }

  try {
    const content = fs.readFileSync(INIT_DB_PATH, 'utf8');
    
    // Regex targeting CREATE TABLE ending with isolated closing bracket on new line
    const createTableRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)/g;
    let match;
    let md = '';
    let tableIndex = 1;

    while ((match = createTableRegex.exec(content)) !== null) {
      const tableName = match[1];
      let columns = match[2].trim();
      
      columns = columns.split('\n')
        .map(line => '    ' + line.trim())
        .join('\n');

      md += `### ${tableIndex}. Table \`${tableName}\`\n`;
      if (tableName === 'conversation_history') {
        md += 'Stores the translation and conversation history of users.\n';
      } else if (tableName === 'users') {
        md += 'Manages user accounts, authorization, and roles (Admin/User).\n';
      } else {
        md += `Database table \`${tableName}\`.\n`;
      }

      md += '```sql\n';
      md += `CREATE TABLE IF NOT EXISTS ${tableName} (\n${columns}\n);\n`;
      
      if (tableName === 'conversation_history') {
        md += '\n-- Optimized indexes for query performance:\n';
        md += 'CREATE INDEX IF NOT EXISTS idx_conv_user_id ON conversation_history(user_id);\n';
        md += 'CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversation_history(created_at DESC);\n';
      }
      md += '```\n\n';
      
      tableIndex++;
    }

    if (md === '') {
      // Fallback in case of parsing mismatch
      md = `### 1. Table \`conversation_history\`
Stores the translation and conversation history of users.
\`\`\`sql
CREATE TABLE conversation_history (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    source_text TEXT NOT NULL,
    target_text TEXT NOT NULL,
    from_lang VARCHAR(10) NOT NULL,
    to_lang VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Optimized indexes for query performance:
CREATE INDEX idx_conv_user_id ON conversation_history(user_id);
CREATE INDEX idx_conv_created_at ON conversation_history(created_at DESC);
\`\`\`

### 2. Table \`users\`
Manages user accounts, authorization, and roles (Admin/User).
\`\`\`sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    name VARCHAR(200) NOT NULL,
    unit VARCHAR(200) DEFAULT '',
    avatar VARCHAR(500) DEFAULT '',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
\`\`\``;
    }

    md += `#### Default seed data:
* **Admin:** \`admin\` / \`admin123\` (Access to the admin panel at \`/admin\`)
* **User 1:** \`user1\` / \`123456\`
* **User 2:** \`user2\` / \`123456\``;

    return md;
  } catch (error) {
    console.error('❌ Error parsing scripts/init-db.js:', error.message);
    return '*(Error parsing database)*';
  }
}

// 4. Main runner function
function updateSkillFile() {
  console.log('🔄 Starting project Skill update...');

  if (!fs.existsSync(SKILL_FILE_PATH)) {
    console.error(`❌ Skill template file not found at: ${SKILL_FILE_PATH}`);
    process.exit(1);
  }

  let skillContent = fs.readFileSync(SKILL_FILE_PATH, 'utf8');

  // A. Update Folder Tree
  console.log('📂 Scanning directory structure...');
  const fileTree = generateFileTree(ROOT_DIR);
  const treeBlock = `\`\`\`\n${fileTree}\`\`\``;
  skillContent = replacePlaceholder(skillContent, 'SKILL_TREE_START', 'SKILL_TREE_END', treeBlock);

  // B. Update Dependencies
  console.log('📦 Extracting dependencies...');
  const depsMarkdown = getDependenciesMarkdown();
  skillContent = replacePlaceholder(skillContent, 'SKILL_DEP_START', 'SKILL_DEP_END', depsMarkdown);

  // C. Update Database Schemas
  console.log('🗃 Extracting database structure...');
  const dbMarkdown = getDatabaseSchemaMarkdown();
  skillContent = replacePlaceholder(skillContent, 'SKILL_DB_START', 'SKILL_DB_END', dbMarkdown);

  // D. Update Last Updated Date
  const today = new Date().toISOString().split('T')[0];
  skillContent = skillContent.replace(/\* \*\*Last Updated:\*\* \d{4}-\d{2}-\d{2}/, `* **Last Updated:** ${today}`);

  // Save back to the primary skill location (.gemini/skills/voice-translate.md)
  fs.writeFileSync(SKILL_FILE_PATH, skillContent, 'utf8');
  console.log(`✅ Updated primary Skill file at: ${SKILL_FILE_RELATIVE}`);

  // Mirror to project_skill.md in the root workspace
  fs.writeFileSync(ROOT_SKILL_FILE_PATH, skillContent, 'utf8');
  console.log(`✅ Synced to root mirror at: project_skill.md`);
  console.log('🎉 Project Skill successfully updated!');
}

// Helper to swap content within placeholder comments
function replacePlaceholder(content, startTag, endTag, newContent) {
  const startComment = `<!-- ${startTag} -->`;
  const endComment = `<!-- ${endTag} -->`;
  
  const startIndex = content.indexOf(startComment);
  const endIndex = content.indexOf(endComment);
  
  if (startIndex === -1 || endIndex === -1) {
    console.warn(`⚠️ Warning: Placeholder ${startTag} or ${endTag} not found`);
    return content;
  }
  
  const before = content.substring(0, startIndex + startComment.length);
  const after = content.substring(endIndex);
  
  return `${before}\n${newContent}\n${after}`;
}

updateSkillFile();
