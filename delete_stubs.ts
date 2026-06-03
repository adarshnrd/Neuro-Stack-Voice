import fs from 'fs';
import path from 'path';

const files = [
  'server.js',
  'src/config/index.js',
  'src/api/repositories/interview.repository.js',
  'src/middleware/errorHandler.js'
];

files.forEach(file => {
  const filePath = path.resolve(file);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Successfully deleted: ${file}`);
    } else {
      console.log(`File not found, skipping: ${file}`);
    }
  } catch (error) {
    console.error(`Error deleting ${file}:`, error);
  }
});

// Self-destruct
try {
  fs.unlinkSync(__filename);
  console.log('Temporary deletion script cleaned up successfully.');
} catch (error) {
  console.error('Error cleaning up deletion script:', error);
}
