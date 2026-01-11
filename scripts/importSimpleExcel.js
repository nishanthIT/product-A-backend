import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Simple import function - only Description and Barcode
async function importSimpleExcel() {
    console.log('🚀 Starting simple Excel import (Description + Barcode only)...\n');
    
    const excelPath = path.join(__dirname, '..', 'data', 'product_data.xlsx');
    
    if (!fs.existsSync(excelPath)) {
        console.error(`❌ Excel file not found: ${excelPath}`);
        return;
    }

    try {
        const workbook = XLSX.readFile(excelPath);
        const worksheet = workbook.Sheets['Sheet1'];
        
        if (!worksheet) {
            console.error('❌ Sheet1 not found in Excel file');
            return;
        }

        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        console.log(`📊 Found ${jsonData.length} rows in Sheet1`);

        let successCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const [index, row] of jsonData.entries()) {
            try {
                const description = row['Description'];
                const barcode = row['Barcode'];

                // Skip if no description or barcode
                if (!description || !barcode) {
                    continue;
                }

                const cleanBarcode = String(barcode).trim();
                const cleanDescription = String(description).trim();

                // Check if barcode already exists - SKIP if exists
                const existingProduct = await prisma.product.findUnique({
                    where: { barcode: cleanBarcode }
                });

                if (existingProduct) {
                    skippedCount++;
                    if (skippedCount % 1000 === 0) {
                        console.log(`   ⏭️  Skipped ${skippedCount} existing products...`);
                    }
                    continue;
                }

                // Create new product with backend API image URL
                await prisma.product.create({
                    data: {
                        title: cleanDescription,
                        barcode: cleanBarcode,
                        img: {
                            type: 'api',
                            url: `https://backend.h7tex.com/api/image/${cleanBarcode}`,
                            filename: null,
                            ean: cleanBarcode,
                            category: 'excel-import'
                        }
                    }
                });

                successCount++;
                
                if (successCount % 500 === 0) {
                    console.log(`   ✅ Imported ${successCount} new products...`);
                }

            } catch (error) {
                errorCount++;
                console.error(`❌ Error processing row ${index + 1}:`, error.message);
                continue;
            }
        }

        console.log('\n🎉 Simple Excel Import Summary:');
        console.log(`✅ New products imported: ${successCount}`);
        console.log(`⏭️  Existing products skipped: ${skippedCount}`);
        console.log(`❌ Total errors: ${errorCount}`);

        console.log('\n💡 All new products have backend API image URLs:');
        console.log('   https://backend.h7tex.com/api/image/{barcode}');

    } catch (error) {
        console.error('❌ Fatal error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the script
const isMainScript = process.argv[1] && process.argv[1].endsWith('importSimpleExcel.js');
if (isMainScript) {
    importSimpleExcel().catch(console.error);
}

export { importSimpleExcel };