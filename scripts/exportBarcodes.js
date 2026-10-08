import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// Fetches all existing (old) barcodes from the Product table and writes them to barcode.txt
async function exportBarcodes() {
    try {
        console.log('🔍 Fetching barcodes from database...');

        const products = await prisma.product.findMany({
            where: { barcode: { not: null } },
            select: { barcode: true }
        });

        const barcodes = products
            .map((p) => p.barcode)
            .filter(Boolean);

        const outputPath = path.join(__dirname, '..', 'barcode.txt');
        fs.writeFileSync(outputPath, barcodes.join('\n'), 'utf8');

        console.log(`✅ Wrote ${barcodes.length} barcodes to ${outputPath}`);
    } catch (error) {
        console.error('❌ Error exporting barcodes:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

exportBarcodes();
