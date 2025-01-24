import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const addEmployee = async (req, res) => {
  try {
    const { name, phoneNo, email, password } = req.body;
    const employee = await prisma.empolyee.create({
      data: {
        name: name,
        phoneNo: phoneNo,
        email: email,
        password: password,
      },
    });
    res.json(employee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const { id, name, phoneNo, email, password } = req.body;
    const employee = await prisma.empolyee.update({
      where: {
        id: id,
      },
      data: {
        name: name,
        phoneNo: phoneNo,
        email: email,
        password: password,
      },
    });
    console.log(employee);
    res.json(employee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    console.log(id);
    const employee = await prisma.empolyee.delete({
      where: {
        id: id,
      },
    });
    res.json(employee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const getEmployee = async (req, res) => {
  try {
    // const { id } = parseInt(req.params);
    // const prm_id = parseInt(id);
    const id = parseInt(req.params.id);

    const employee = await prisma.empolyee.findUnique({
      where: {
        id: id,
      },
    });
    console.log(employee);
    res.json(employee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { addEmployee, updateEmployee, deleteEmployee, getEmployee };
