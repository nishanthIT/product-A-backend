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
    const customer = await prisma.customer.delete({
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
