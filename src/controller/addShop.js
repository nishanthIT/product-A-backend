// import { PrismaClient } from "@prisma/client";
// const prisma = new PrismaClient();

// const addShop = async (req, res) => {
//   try {
//     const { name, address, mobile } = req.body;
//     const shop = {
//       name,
//       address,
//       mobile,
//     };

//     const newShop = await prisma.shop.create({
//       data: shop,
//     });
//     res.status(201).json(newShop);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Something went wrong" });
//   }
// };

// const editShop = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { name, address, mobile } = req.body;
//     const shop = {
//       name,
//       address,
//       mobile,
//     };

//     console.log(name, address, mobile);

//     const updatedShop = await prisma.shop.update({
//       where: {
//         id,
//       },
//       data: shop,
//     });
//     console.log(name, address, mobile);

//     res.status(200).json(updatedShop);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Something went wrong" });
//   }
// };

// export { addShop, editShop };






import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const addShop = async (req, res) => {
  try {
    const { name, address, mobile } = req.body;
    const shop = {
      name,
      address,
      mobile,
    };

    const newShop = await prisma.shop.create({
      data: shop,
    });
    res.status(201).json(newShop);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};

// const editShop = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { name, address, mobile } = req.body;
//     const shop = {
//       name,
//       address,
//       mobile,
//     };

//     console.log(name, address, mobile);

//     const updatedShop = await prisma.shop.update({
//       where: {
//         id,
//       },
//       data: shop,
//     });
//     console.log(name, address, mobile);

//     res.status(200).json(updatedShop);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Something went wrong" });
//   }
// };


const editShop = async (req, res) => {
  try {
    const { id } = req.params; // Prisma expects `id` to be a string
    const { name, address, mobile } = req.body;

    const updatedShop = await prisma.shop.update({
      where: { id: String(id) },  // Ensure the id is treated as a string
      data: { name, address, mobile },
    });

    res.status(200).json(updatedShop);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};




const getShopById = async (req, res) => {
  try {
    const { id } = req.params;

    const shop = await prisma.shop.findUnique({
      where: {
        id: id, // Ensure the ID is converted to a number if it's coming as a string
      },
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    res.status(200).json(shop);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};


const getAllShops = async (req, res) => {
  try {
    const shops = await prisma.shop.findMany({
      include: {
        _count: {
          select: { products: true }, // Count the number of related products for each shop
        },
      },
    });

    // Map the result to include the total products count
    const shopsWithProductCount = shops.map((shop) => ({
      id: shop.id,
      name: shop.name,
      address: shop.address,
      mobile: shop.mobile,
      totalProducts: shop._count.products, // Include the total products count
    }));

    res.status(200).json(shopsWithProductCount);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};

const deleteShop = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid or missing ID" });
    }

    // Perform the deletion
    const deletedShop = await prisma.shop.delete({
      where: {
        id, // Use the `id` directly since it's a string
      },
    });

    res.status(200).json(deletedShop);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};


export { addShop, editShop,getAllShops,getShopById,deleteShop };

