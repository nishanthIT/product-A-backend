// import path from 'path';
// import fs from 'fs';
// import { fileURLToPath } from 'url';

// // Get the directory name in ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const IMAGE_DIRECTORY = process.env.IMAGE_DIRECTORY || path.join(__dirname, 'images');

// const image = async (req, res) => {
//   const { barcode } = req.params;
  
//   // Validate barcode to prevent directory traversal attacks
//   if (!barcode || /[\/\\]/.test(barcode)) {
//     return res.status(400).send('Invalid barcode format');
//   }
  
//   const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
//   let imagePath = null;
  
//   for (const ext of extensions) {
//     const testPath = path.join(IMAGE_DIRECTORY, `${barcode}${ext}`);
//     if (fs.existsSync(testPath)) {
//       imagePath = testPath;
//       break;
//     }
//   }
//   console.log(`Image ${imagePath} found for barcode: ${barcode}`);
//   if (!imagePath) {
//     console.log(`Image not found for barcode: ${barcode}`);
//     return res.status(404).send('Image not found');
//   }
  
//   res.sendFile(imagePath);
// };

// export { image };


import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Get the project root directory (not just the current file's directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..'); // Adjust based on where this file is located within src

// Set image directory to the 'images' folder at project root
const IMAGE_DIRECTORY = path.join(PROJECT_ROOT, 'images');

console.log(`Image controller initialized`);
console.log(`Using image directory: ${IMAGE_DIRECTORY}`);

const image = async (req, res) => {
  const { barcode } = req.params;
  
  console.log(`Received image request for barcode: ${barcode}`);
  
  // Validate barcode to prevent directory traversal attacks
  if (!barcode || /[\/\\]/.test(barcode)) {
    console.log(`Invalid barcode format: ${barcode}`);
    return res.status(400).send('Invalid barcode format');
  }
  
  const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  let imagePath = null;
  
  // List first few files in the directory for debugging
  try {
    const files = fs.readdirSync(IMAGE_DIRECTORY);
    console.log(`Images directory contains ${files.length} files. First few: ${files.slice(0, 5).join(', ')}`);
  } catch (err) {
    console.error(`Error reading images directory: ${err.message}`);
    return res.status(500).send('Server configuration error');
  }
  
  // Try each extension
  for (const ext of extensions) {
    const testPath = path.join(IMAGE_DIRECTORY, `${barcode}${ext}`);
    console.log(`Looking for: ${testPath}`);
    
    if (fs.existsSync(testPath)) {
      imagePath = testPath;
      console.log(`Found image at: ${imagePath}`);
      break;
    }
  }
  
  if (!imagePath) {
    console.log(`No image found for barcode: ${barcode}`);
    return res.status(404).send('Image not found');
  }
  
  // Send the file with error handling
  res.sendFile(imagePath, (err) => {
    if (err) {
      console.error(`Error sending file: ${err.message}`);
      // Don't attempt to send another response if headers already sent
      if (!res.headersSent) {
        res.status(500).send('Error serving image');
      }
    } else {
      console.log(`Successfully served image for barcode: ${barcode}`);
    }
  });
};

export { image };