import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to analyze Excel file structure
function analyzeExcelFile() {
    const excelPath = path.join(__dirname, '..', 'data', 'product_data.xlsx');
    
    console.log(`📊 Analyzing Excel file: ${path.basename(excelPath)}\n`);
    
    try {
        const workbook = XLSX.readFile(excelPath);
        const sheetNames = workbook.SheetNames;
        
        console.log(`📋 Found ${sheetNames.length} sheets: ${sheetNames.join(', ')}\n`);
        
        // Analyze each sheet
        sheetNames.forEach((sheetName, sheetIndex) => {
            console.log(`🔍 === Sheet ${sheetIndex + 1}: ${sheetName} ===`);
            
            const worksheet = workbook.Sheets[sheetName];
            const range = XLSX.utils.decode_range(worksheet['!ref']);
            
            console.log(`📏 Range: ${worksheet['!ref']} (${range.e.r + 1} rows, ${range.e.c + 1} columns)`);
            
            // Get headers (first row)
            const headers = [];
            for (let col = range.s.c; col <= range.e.c; col++) {
                const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
                const cell = worksheet[cellAddress];
                headers.push(cell ? cell.v : `Column_${col}`);
            }
            
            console.log(`📝 Headers (${headers.length} columns):`);
            headers.forEach((header, index) => {
                console.log(`   ${index + 1}. ${header}`);
            });
            
            // Sample data from first few rows
            console.log(`\n📋 Sample data (first 3 rows):`);
            for (let row = 1; row <= Math.min(3, range.e.r); row++) {
                const rowData = [];
                for (let col = range.s.c; col <= range.e.c; col++) {
                    const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
                    const cell = worksheet[cellAddress];
                    rowData.push(cell ? cell.v : '');
                }
                console.log(`   Row ${row + 1}: [${rowData.slice(0, 5).map(v => String(v).substring(0, 20)).join(' | ')}${rowData.length > 5 ? ' | ...' : ''}]`);
            }
            
            // Count non-empty rows
            let nonEmptyRows = 0;
            for (let row = 1; row <= range.e.r; row++) {
                let hasData = false;
                for (let col = range.s.c; col <= range.e.c; col++) {
                    const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
                    const cell = worksheet[cellAddress];
                    if (cell && cell.v !== null && cell.v !== '' && cell.v !== undefined) {
                        hasData = true;
                        break;
                    }
                }
                if (hasData) nonEmptyRows++;
            }
            
            console.log(`📊 Non-empty data rows: ${nonEmptyRows}`);
            
            // Look for potential key columns
            console.log(`\n🔍 Potential key columns:`);
            const potentialKeys = {
                'Product Name': headers.findIndex(h => h && h.toString().toLowerCase().includes('name')),
                'EAN/Barcode': headers.findIndex(h => h && (h.toString().toLowerCase().includes('ean') || h.toString().toLowerCase().includes('barcode'))),
                'Price/RRP': headers.findIndex(h => h && (h.toString().toLowerCase().includes('price') || h.toString().toLowerCase().includes('rrp'))),
                'Image URL': headers.findIndex(h => h && h.toString().toLowerCase().includes('image')),
                'Size': headers.findIndex(h => h && h.toString().toLowerCase().includes('size'))
            };
            
            Object.entries(potentialKeys).forEach(([key, index]) => {
                if (index >= 0) {
                    console.log(`   ✅ ${key}: Column ${index + 1} (${headers[index]})`);
                } else {
                    console.log(`   ❌ ${key}: Not found`);
                }
            });
            
            console.log('\n' + '='.repeat(80) + '\n');
        });
        
    } catch (error) {
        console.error('❌ Error analyzing Excel file:', error.message);
    }
}

// Run the analysis
analyzeExcelFile();