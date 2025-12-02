import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function checkList() {
  try {
    const listId = "cmi2q66sb0003cahweo0ozd0m";
    
    console.log("Checking list:", listId);
    
    // Find the list
    const list = await prisma.list.findUnique({
      where: { id: listId },
      include: {
        customer: true,
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              }
            }
          }
        }
      }
    });
    
    if (!list) {
      console.log("❌ List not found in database!");
      
      // Show all lists
      const allLists = await prisma.list.findMany({
        include: { customer: true }
      });
      console.log("\nAll lists in database:");
      allLists.forEach(l => {
        console.log(`- ${l.id} | ${l.name} | Customer: ${l.customer.email} (ID: ${l.customerId})`);
      });
    } else {
      console.log("✅ List found!");
      console.log("List details:", {
        id: list.id,
        name: list.name,
        customerId: list.customerId,
        customerEmail: list.customer.email,
        productCount: list.products.length
      });
      
      if (list.products.length > 0) {
        console.log("\nProducts in list:");
        list.products.forEach(lp => {
          console.log(`- ${lp.productAtShop.product.title} at ${lp.productAtShop.shop.name}`);
        });
      }
    }
    
    // Check logged-in customer
    const customers = await prisma.customer.findMany({
      select: { id: true, email: true, name: true }
    });
    console.log("\nAll customers:");
    customers.forEach(c => {
      console.log(`- ${c.email} (ID: ${c.id})`);
    });
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

checkList();
