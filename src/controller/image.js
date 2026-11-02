import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('controller/image.js');
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Get the project root directory (not just the current file's directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..'); // Adjust based on where this file is located within src

// Set image directory to the 'images' folder at project root
const IMAGE_DIRECTORY = path.join(PROJECT_ROOT, 'images');

securityLog.log(`Image controller initialized`);
securityLog.log(`Using image directory: ${IMAGE_DIRECTORY}`);

const image = async (req, res, next) => {
  const { barcode } = req.params;
  if (typeof barcode !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(barcode)) return res.status(400).send('Invalid barcode format');
  try {
    for (const extension of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
      const candidate = path.join(IMAGE_DIRECTORY, `${barcode}${extension}`);
      try { await fs.promises.access(candidate); } catch { continue; }
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(candidate, error => { if (error) next(error); });
    }
    return res.sendStatus(404);
  } catch (error) { next(error); }
};
export { image };
