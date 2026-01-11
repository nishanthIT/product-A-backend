import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Function to process RRP value
function processRRP(rrp) {
    if (!rrp || rrp === 'Login Required' || rrp === 'N/A' || rrp === '') {
        return null;
    }
    
    // Remove currency symbols and extract number
    const numericValue = String(rrp).replace(/[£$€,]/g, '').trim();
    const parsedValue = parseFloat(numericValue);
    
    return isNaN(parsedValue) ? null : parsedValue;
}

// Function to process image URL
function processImageUrl(imageUrl, ean) {
    if (!imageUrl || !ean) return null;

    const url = String(imageUrl).trim();
    
    // Check if it's your backend API URL
    if (url.includes('backend.h7tex.com/api/image/')) {
        return {
            type: 'api',
            url: url,
            filename: null,
            ean: ean
        };
    }

    // Check if it's a downloadable external URL
    if (url.startsWith('http') && !url.includes('default')) {
        return {
            type: 'external_downloadable',
            url: url,
            filename: `${ean}.jpg`,
            ean: ean
        };
    }

    // For default or other images, keep original URL
    return {
        type: 'external',
        url: url,
        filename: null,
        ean: ean
    };
}

// Function to read and analyze Excel file
function analyzeExcelFile(filePath) {
    console.log(`📊 Analyzing Excel file: ${path.basename(filePath)}`);
    
    const workbook = XLSX.readFile(filePath);
    const sheetNames = workbook.SheetNames;
    
    console.log(`📋 Found ${sheetNames.length} sheets: ${sheetNames.join(', ')}`);
    
    // Analyze each sheet
    sheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        console.log(`\n📄 Sheet: ${sheetName}`);
        console.log(`📏 Rows: ${data.length}`);
        
        if (data.length > 0) {
            console.log(`📝 Headers: ${data[0].join(', ')}`);
            
            // Show first few data rows
            if (data.length > 1) {
                console.log('📝 Sample data:');
                for (let i = 1; i <= Math.min(3, data.length - 1); i++) {
                    console.log(`   Row ${i}: ${data[i].slice(0, 5).join(' | ')}${data[i].length > 5 ? ' ...' : ''}`);
                }
            }
        }
    });
}

// Function to import from Excel file
async function importFromExcel(filePath) {
    console.log(`\n🚀 Starting Excel import from ${path.basename(filePath)}...`);
    
    try {
        const workbook = XLSX.readFile(filePath);
        const sheetNames = workbook.SheetNames;
        
        let totalSuccess = 0;
        let totalUpdated = 0;
        let totalErrors = 0;
        
        // Process each sheet (but only Sheet1 contains product data)
        for (const sheetName of sheetNames) {
            if (sheetName !== 'Sheet1') {
                console.log(`⏭️  Skipping ${sheetName} - not product data`);
                continue;
            }
            
            console.log(`\n📋 Processing sheet: ${sheetName}`);
            
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);
            
            if (jsonData.length === 0) {
                console.log(`⚠️  Sheet ${sheetName} is empty`);
                continue;
            }
            
            console.log(`📊 Found ${jsonData.length} rows in ${sheetName}`);
            
            let successCount = 0;
            let skippedCount = 0;
            let errorCount = 0;
            
            for (const [index, row] of jsonData.entries()) {
                try {
                    // Use specific column mappings for this Excel file
                    const name = row['Description'];
                    const ean = row['Barcode'];
                    
                    // Skip if no name or EAN
                    if (!name || !ean || !String(name).trim() || !String(ean).trim()) {
                        continue;
                    }
                    
                    const barcode = String(ean).trim();
                    
                    // Check if product already exists - SKIP if exists
                    const existingProduct = await prisma.product.findUnique({
                        where: { barcode: barcode }
                    });
                    
                    if (existingProduct) {
                        // Skip existing product
                        skippedCount++;
                        if (skippedCount % 1000 === 0) {
                            console.log(`   Skipped ${skippedCount} existing products...`);
                        }
                        continue;
                    }
                    
                    // Create image info using working backend API
                    const imageInfo = {
                        type: 'api',
                        url: `https://backend.h7tex.com/api/image/${barcode}`,
                        filename: null,
                        ean: barcode
                    };
                    const imgJson = imageInfo ? { ...imageInfo, category: 'excel-import' } : null;
                    
                    // Create new product only
                    await prisma.product.create({
                        data: {
                            title: String(name).trim(),
                            barcode: barcode,
                            img: imgJson
                        }
                    });
                    successCount++;
                    
                    if (successCount % 100 === 0) {
                        console.log(`   Imported ${successCount} new products from Excel...`);
                    }
                    
                } catch (error) {
                    errorCount++;
                    console.error(`❌ Error processing row ${index + 1} in ${sheetName}:`, error.message);
                    continue;
                }
            }
            
            console.log(`✅ Sheet ${sheetName}: ${successCount} new products imported, ${skippedCount} existing skipped, ${errorCount} errors`);
            totalSuccess += successCount;
            totalUpdated += skippedCount;  // Using totalUpdated to track skipped for summary
            totalErrors += errorCount;
        }
        
        console.log('\n🎉 Excel Import Summary:');
        console.log(`✅ New products imported: ${totalSuccess}`);
        console.log(`⏭️  Existing products skipped: ${totalUpdated}`);
        console.log(`❌ Total errors: ${totalErrors}`);
        
        return { success: totalSuccess, skipped: totalUpdated, errors: totalErrors };
        
    } catch (error) {
        console.error('❌ Failed to process Excel file:', error);
        return { success: 0, updated: 0, errors: 1 };
    }
}

// Main function
async function main() {
    const excelPath = path.join(__dirname, '..', 'data', 'product_data.xlsx');
    
    if (!fs.existsSync(excelPath)) {
        console.error(`❌ Excel file not found: ${excelPath}`);
        return;
    }
    
    try {
        // First analyze the file structure
        analyzeExcelFile(excelPath);
        
        // Then import the data
        await importFromExcel(excelPath);
        
    } catch (error) {
        console.error('❌ Fatal error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the script
const isMainScript = process.argv[1] && process.argv[1].endsWith('importExcel.js');
if (isMainScript) {
    main().catch(console.error);
}

export { main as importExcelData };