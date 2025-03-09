import { PrismaClient } from '@prisma/client';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

class DatabaseSeeder {
    constructor(excelFilePath) {
        this.excelFilePath = excelFilePath;
        this.prisma = new PrismaClient();
        this.logger = this.setupLogger();
    }

    setupLogger() {
        // Create logs directory if it doesn't exist
        const logDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logDir)){
            fs.mkdirSync(logDir, { recursive: true });
        }

        return {
            log: (message) => {
                console.log(message);
                fs.appendFileSync(path.join(logDir, 'seeder.log'), `${new Date().toISOString()} - ${message}\n`);
            },
            error: (message) => {
                console.error(message);
                fs.appendFileSync(path.join(logDir, 'seeder_error.log'), `${new Date().toISOString()} - ${message}\n`);
            }
        };
    }

    readExcelFile() {
        try {
            const workbook = XLSX.readFile(this.excelFilePath);
            const worksheet = workbook.Sheets['Sheet3'];
            return XLSX.utils.sheet_to_json(worksheet);
        } catch (error) {
            this.logger.error(`Error reading Excel file: ${error.message}`);
            throw error;
        }
    }

    generateImageUrl(barcode) {
        return `https://backend.h7tex.com/api/image/${barcode}`;
    }

    async seedProducts() {
        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        const excelData = this.readExcelFile();

        for (const row of excelData) {
            try {
                // Extract relevant fields
                const barcode = String(row['Barcode']).split('.')[0].trim();
                const description = row['Description'] || '';
                const saleWithVat = row['SalWithVaT'] ? parseFloat(row['SalWithVaT']) : null;

                // Check if product already exists
                const existingProduct = await this.prisma.product.findUnique({
                    where: { barcode: barcode }
                });

                if (existingProduct) {
                    this.logger.log(`Skipping existing product: ${barcode}`);
                    skippedCount++;
                    continue;
                }

                // Generate standard image URL
                const imageUrl = this.generateImageUrl(barcode);

                // Create product
                const newProduct = await this.prisma.product.create({
                    data: {
                        barcode: barcode,
                        title: description,
                        rrp: saleWithVat ? saleWithVat : null,
                        img: imageUrl,
                        packetSize: row['PacketSize'] || null,
                        caseSize: row['CaseSize'] || null,
                        retailSize: row['RetailSize'] || null
                    }
                });

                processedCount++;
                this.logger.log(`Added product: ${barcode}`);
            } catch (error) {
                this.logger.error(`Error processing barcode ${row['Barcode']}: ${error.message}`);
                errorCount++;
            }
        }

        // Summary log
        this.logger.log(`\nSeeding Summary:
- Total products processed: ${processedCount}
- Skipped existing products: ${skippedCount}
- Error count: ${errorCount}`);
    }

    async run() {
        try {
            await this.seedProducts();
        } catch (error) {
            this.logger.error(`Seeding failed: ${error.message}`);
        } finally {
            await this.prisma.$disconnect();
        }
    }
}

// Usage
async function main() {
    const seeder = new DatabaseSeeder('product list.xlsx');
    await seeder.run();
}

main().catch(console.error);