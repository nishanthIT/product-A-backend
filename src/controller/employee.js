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
    const {id} = req.params
    const { name, phoneNo, email, password } = req.body;
    const employee = await prisma.empolyee.update({
      where: {
        id: parseInt(id, 10),
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
    const { id } = req.params;
    const employee = await prisma.empolyee.delete({
      
      where: {
        id:  parseInt(id),
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


const getAllEmployees = async (req, res) => {
  try {
    // Fetch all employees
    const employees = await prisma.empolyee.findMany({
      select: {
        id: true,
        name: true,
        phoneNo: true,
        email: true,
        password: true
      },
    });

    // Fetch all product activities for each employee (Count the number of actions)
    const activityData = await prisma.actionLog.groupBy({
      by: ["employeeId", "timestamp"],
      where: {
        actionType: "ADD",
      },
      _count: {
        id: true, // Count the number of action logs per employee
      },
    });

    // Organize activity data into the required format
    const employeeActivity = employees.map((employee) => {
      const activities = activityData
        .filter((activity) => activity.employeeId === employee.id)
        .reduce((acc, activity) => {
          const date = new Date(activity.timestamp).toISOString().split("T")[0];
          const hour = new Date(activity.timestamp).getHours();
          const existingDateEntry = acc.find((entry) => entry.date === date);

          if (existingDateEntry) {
            const hourEntry = existingDateEntry.hourlyBreakdown.find(
              (h) => h.hour === `${hour}:00`
            );
            if (hourEntry) {
              hourEntry.count += activity._count.id; // Use the count of actions
            } else {
              existingDateEntry.hourlyBreakdown.push({
                hour: `${hour}:00`,
                count: activity._count.id,
              });
            }
          } else {
            acc.push({
              date,
              totalProducts: activity._count.id, // Count of products added in total
              hourlyBreakdown: [
                {
                  hour: `${hour}:00`,
                  count: activity._count.id,
                },
              ],
            });
          }

          return acc;
        }, []);

      return {
        id: employee.id,
        name: employee.name,
        phone: employee.phoneNo,
        email: employee.email,
        password: employee.password,
        activities,
      };
    });

    res.status(200).json({
      success: true,
      data: employeeActivity,
    });
  } catch (error) {
    console.error("Error fetching employees and their activities:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};





export { addEmployee, updateEmployee, deleteEmployee, getEmployee,getAllEmployees };
