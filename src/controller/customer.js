import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const addCustomer = async (req, res) => {
  try {
    const { name, mobile, email, password } = req.body;
    const customer = await prisma.customer.create({
      data: {
        name: name,
        mobile: mobile,
        email: email,
        password: password,
      },
    });
    res.json(customer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const { id, name, mobile, email, password } = req.body;
    const customer = await prisma.customer.update({
      where: {
        id: id,
      },
      data: {
        name: name,
        mobile: mobile,
        email: email,
        password: password,
      },
    });
    res.json(customer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const id = Number(req.params.id);
    
    // First, delete all chat-related data for this customer
    // Delete message read receipts
    await prisma.messageRead.deleteMany({
      where: {
        userId: id,
        userType: 'CUSTOMER'
      }
    });
    
    // Delete messages sent by this customer
    await prisma.message.deleteMany({
      where: {
        senderId: id,
        senderType: 'CUSTOMER'
      }
    });
    
    // Delete chat participations
    await prisma.chatParticipant.deleteMany({
      where: {
        userId: id,
        userType: 'CUSTOMER'
      }
    });
    
    // Delete ProductAtShop records managed by this customer (if any)
    await prisma.productAtShop.updateMany({
      where: {
        userId: id
      },
      data: {
        userId: null
      }
    });
    
    // Now delete the customer (Lists, ListProducts, and PriceReports will cascade)
    const customer = await prisma.customer.delete({
      where: {
        id: id,
      },
    });
    
    console.log(`✅ Customer ${id} and all related data deleted successfully`);
    res.json({ 
      success: true, 
      message: 'Customer and all related data deleted successfully',
      customer 
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: "Internal server error.", details: error.message });
  }
};

const getCustomer = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const customer = await prisma.customer.findUnique({
      where: {
        id: id,
      },
    });

    res.json(customer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { addCustomer, updateCustomer, deleteCustomer, getCustomer };
