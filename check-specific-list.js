import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function checkList() {
  try {
    const listId = "cmi2p343y0001caykwojpnxef"; // The list from your error log
    const productId = "cm80obn580000uk4skwspgbdm"; // The product trying to delete
    
    console.log("Checking list:", listId);
    console.log("Product to delete:", productId);
    
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
      
      // Show all lists for customer 4
      const allLists = await prisma.list.findMany({
        where: { customerId: 4 },
        include: { customer: true }
      });
      console.log("\nAll lists for customer ID 4:");
      allLists.forEach(l => {
        console.log(`- ${l.id} | ${l.name}`);
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
          const product = lp.productAtShop.product;
          console.log(`- ID: ${product.id} | ${product.title} at ${lp.productAtShop.shop.name}`);
          if (product.id === productId) {
            console.log("  ✅ THIS IS THE PRODUCT YOU'RE TRYING TO DELETE");
          }
        });
      }
    }
    
    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    
    if (product) {
      console.log("\n✅ Product exists:", product.title);
    } else {
      console.log("\n❌ Product not found in database!");
    }
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

checkList();
