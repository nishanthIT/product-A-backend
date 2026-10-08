// import { PrismaClient } from "@prisma/client";
// const prisma = new PrismaClient();

// const addempolyee = async (req, res) => {
//   try {
//     const { name, phoneNo, email, password } = req.body;
//     const empolyee = await prisma.empolyee.create({
//       data: {
//         name: name,
//         phoneNo: phoneNo,
//         email: email,
//         password: password,
//       },
//     });
//     res.json(empolyee);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };

// const updateempolyee = async (req, res) => {
//   try {
//     const {id} = req.params
//     const { name, phoneNo, email, password } = req.body;
//     const empolyee = await prisma.empolyee.update({
//       where: {
//         id: parseInt(id, 10),
//       },
//       data: {
//         name: name,
//         phoneNo: phoneNo,
//         email: email,
//         password: password,
//       },
//     });
//     console.log(empolyee);
//     res.json(employee);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };

// const deleteEmployee = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const employee = await prisma.empolyee.delete({
      
//       where: {
//         id:  parseInt(id),
//       },
//     });
//     res.json(employee);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };

// const getEmployee = async (req, res) => {
//   try {
//     // const { id } = parseInt(req.params);
//     // const prm_id = parseInt(id);
//     const id = parseInt(req.params.id);

//     const employee = await prisma.empolyee.findUnique({
//       where: {
//         id: id,
//       },
//     });
//     console.log(employee);
//     res.json(employee);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };


// const getAllEmployees = async (req, res) => {
//   try {
//     // Fetch all employees
//     const employees = await prisma.empolyee.findMany({
//       select: {
//         id: true,
//         name: true,
//         phoneNo: true,
//         email: true,
//         password: true
//       },
//     });

//     // Fetch all product activities for each employee (Count the number of actions)
//     const activityData = await prisma.actionLog.groupBy({
//       by: ["employeeId", "timestamp"],
//       where: {
//         actionType: "ADD",
//       },
//       _count: {
//         id: true, // Count the number of action logs per employee
//       },
//     });

//     // Organize activity data into the required format
//     const employeeActivity = employees.map((employee) => {
//       const activities = activityData
//         .filter((activity) => activity.employeeId === employee.id)
//         .reduce((acc, activity) => {
//           const date = new Date(activity.timestamp).toISOString().split("T")[0];
//           const hour = new Date(activity.timestamp).getHours();
//           const existingDateEntry = acc.find((entry) => entry.date === date);

//           if (existingDateEntry) {
//             const hourEntry = existingDateEntry.hourlyBreakdown.find(
//               (h) => h.hour === `${hour}:00`
//             );
//             if (hourEntry) {
//               hourEntry.count += activity._count.id; // Use the count of actions
//             } else {
//               existingDateEntry.hourlyBreakdown.push({
//                 hour: `${hour}:00`,
//                 count: activity._count.id,
//               });
//             }
//           } else {
//             acc.push({
//               date,
//               totalProducts: activity._count.id, // Count of products added in total
//               hourlyBreakdown: [
//                 {
//                   hour: `${hour}:00`,
//                   count: activity._count.id,
//                 },
//               ],
//             });
//           }

//           return acc;
//         }, []);

//       return {
//         id: employee.id,
//         name: employee.name,
//         phone: employee.phoneNo,
//         email: employee.email,
//         password: employee.password,
//         activities,
//       };
//     });

//     res.status(200).json({
//       success: true,
//       data: employeeActivity,
//     });
//   } catch (error) {
//     console.error("Error fetching employees and their activities:", error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };





// export { addEmployee, updateEmployee, deleteEmployee, getEmployee,getAllEmployees };

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  ALL_COMPANY_PERMISSIONS,
  COMPANY_PERMISSIONS,
  COMPANY_STAFF_ROLES,
  DEFAULT_COMPANY_STAFF_PERMISSIONS,
} from "../services/accessControl.js";

// Company Staff management. Every handler here is mounted behind
// requireCompanyPermission('staff.manage') and only touches CompanyStaffMembership.
const prisma = new PrismaClient();

const staffSelect = {
  id: true,
  name: true,
  phoneNo: true,
  email: true,
  createdAt: true,
  lastActiveAt: true,
  companyMembership: {
    select: { role: true, permissions: true, status: true, createdAt: true, deactivatedAt: true },
  },
};

const formatStaff = (employee) => ({
  id: employee.id,
  name: employee.name,
  phoneNo: employee.phoneNo,
  email: employee.email,
  createdAt: employee.createdAt,
  lastActiveAt: employee.lastActiveAt,
  role: employee.companyMembership?.role ?? null,
  permissions: employee.companyMembership?.permissions ?? [],
  status: employee.companyMembership?.status ?? null,
});

/**
 * Validates company role/permissions and blocks privilege escalation:
 * only Admins grant MANAGER or staff.manage; staff managers may grant only what they hold.
 */
function validateCompanyGrant(body, actor, { partial }) {
  const result = {};
  const isSuperAdmin = actor.userType === "ADMIN";

  if (body.role !== undefined) {
    const role = String(body.role).toUpperCase();
    if (!COMPANY_STAFF_ROLES.includes(role)) {
      return { error: `Role must be one of: ${COMPANY_STAFF_ROLES.join(", ")}` };
    }
    if (role === "MANAGER" && !isSuperAdmin) {
      return { error: "Only a company admin can assign the manager role" };
    }
    result.role = role;
  } else if (!partial) {
    result.role = "STAFF";
  }

  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== "string")) {
      return { error: "Permissions must be a list of permission names" };
    }
    const unknown = body.permissions.filter((p) => !ALL_COMPANY_PERMISSIONS.includes(p));
    if (unknown.length > 0) return { error: `Unknown company permission: ${unknown.join(", ")}` };
    if (!isSuperAdmin) {
      const held = actor.company?.permissions ?? [];
      if (body.permissions.includes(COMPANY_PERMISSIONS.STAFF_MANAGE) || body.permissions.some((p) => !held.includes(p))) {
        return { error: "You cannot grant permissions you do not hold" };
      }
    }
    result.permissions = [...new Set(body.permissions)];
  } else if (!partial) {
    result.permissions = [...DEFAULT_COMPANY_STAFF_PERMISSIONS];
  }

  return result;
}

// Non-admin staff managers may not change other managers or themselves.
function canActOnStaff(actor, employeeId, membership) {
  if (actor.userType === "ADMIN") return true;
  if (actor.userType === "EMPLOYEE" && Number(actor.id) === employeeId) return false;
  return membership?.role !== "MANAGER";
}

async function emailInUse(email, exceptEmployeeId) {
  const [admin, employee, customer] = await Promise.all([
    prisma.admin.findFirst({ where: { email }, select: { id: true } }),
    prisma.empolyee.findFirst({
      where: { email, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) },
      select: { id: true },
    }),
    prisma.customer.findFirst({ where: { email }, select: { id: true } }),
  ]);
  return { admin, employee, customer };
}

const addEmployee = async (req, res) => {
  try {
    const { name, phoneNo, password } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }

    const grant = validateCompanyGrant(req.body, req.user, { partial: false });
    if (grant.error) return res.status(400).json({ error: grant.error });

    const existing = await emailInUse(email);
    if (existing.employee) {
      return res.status(409).json({
        error: "An employee account with this email already exists. Grant company access to it explicitly instead.",
        code: "ACCOUNT_EXISTS",
        employeeId: existing.employee.id,
      });
    }
    if (existing.admin || existing.customer) {
      return res.status(400).json({ error: "An account with this email already exists." });
    }
    if (phoneNo && await prisma.empolyee.findFirst({ where: { phoneNo }, select: { id: true } })) {
      return res.status(400).json({ error: "An employee with this phone number already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const grantedByAdminId = req.user.userType === "ADMIN" ? req.user.id : null;

    const employee = await prisma.empolyee.create({
      data: {
        name,
        phoneNo: phoneNo || `temp_${Date.now()}`,
        email,
        password: hashedPassword,
        createdByAdminId: grantedByAdminId,
        companyMembership: {
          create: {
            role: grant.role,
            permissions: grant.permissions,
            status: "ACTIVE",
            grantedByAdminId,
            source: "COMPANY_STAFF_FLOW",
          },
        },
      },
      select: staffSelect,
    });

    res.status(201).json({ message: "Company staff member created", employee: formatStaff(employee) });
  } catch (error) {
    console.error("Error adding company staff:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Explicitly grants company membership to an existing employee account (e.g. after access review).
const grantCompanyAccess = async (req, res) => {
  try {
    const employeeId = parseInt(req.body.employeeId, 10);
    if (Number.isNaN(employeeId)) return res.status(400).json({ error: "employeeId is required" });

    const grant = validateCompanyGrant(req.body, req.user, { partial: false });
    if (grant.error) return res.status(400).json({ error: grant.error });

    const employee = await prisma.empolyee.findUnique({
      where: { id: employeeId },
      select: { id: true, companyMembership: { select: { role: true } } },
    });
    if (!employee) return res.status(404).json({ error: "Employee account not found" });
    if (!canActOnStaff(req.user, employeeId, employee.companyMembership)) {
      return res.status(403).json({ error: "You cannot change this staff member" });
    }

    const grantedByAdminId = req.user.userType === "ADMIN" ? req.user.id : null;
    await prisma.companyStaffMembership.upsert({
      where: { employeeId },
      create: {
        employeeId,
        role: grant.role,
        permissions: grant.permissions,
        status: "ACTIVE",
        grantedByAdminId,
        source: "COMPANY_STAFF_FLOW",
      },
      update: {
        role: grant.role,
        permissions: grant.permissions,
        status: "ACTIVE",
        deactivatedAt: null,
        grantedByAdminId,
      },
    });

    const updated = await prisma.empolyee.findUnique({ where: { id: employeeId }, select: staffSelect });
    res.json({ message: "Company access granted", employee: formatStaff(updated) });
  } catch (error) {
    console.error("Error granting company access:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const findStaffMember = (id) =>
  prisma.empolyee.findFirst({
    where: { id, companyMembership: { status: { not: "REMOVED" } } },
    select: { id: true, companyMembership: { select: { role: true } } },
  });

const updateEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, phoneNo, password } = req.body;
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;

    const staff = Number.isNaN(id) ? null : await findStaffMember(id);
    if (!staff) return res.status(404).json({ error: "Company staff member not found" });
    if (!canActOnStaff(req.user, id, staff.companyMembership)) {
      return res.status(403).json({ error: "You cannot change this staff member" });
    }

    const grant = validateCompanyGrant(req.body, req.user, { partial: true });
    if (grant.error) return res.status(400).json({ error: grant.error });

    const status = req.body.status !== undefined ? String(req.body.status).toUpperCase() : undefined;
    if (status !== undefined && !["ACTIVE", "INACTIVE"].includes(status)) {
      return res.status(400).json({ error: "Status must be ACTIVE or INACTIVE" });
    }

    if (email) {
      const existing = await emailInUse(email, id);
      if (existing.admin || existing.employee || existing.customer) {
        return res.status(400).json({ error: "Email already in use by another account" });
      }
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;

    await prisma.$transaction([
      prisma.empolyee.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(phoneNo && { phoneNo }),
          ...(email && { email }),
          ...(hashedPassword && { password: hashedPassword }),
        },
      }),
      prisma.companyStaffMembership.update({
        where: { employeeId: id },
        data: {
          ...(grant.role !== undefined && { role: grant.role }),
          ...(grant.permissions !== undefined && { permissions: grant.permissions }),
          ...(status !== undefined && { status, deactivatedAt: status === "ACTIVE" ? null : new Date() }),
        },
      }),
    ]);

    const employee = await prisma.empolyee.findUnique({ where: { id }, select: staffSelect });
    res.json({ message: "Company staff member updated", employee: formatStaff(employee) });
  } catch (error) {
    console.error("Error updating company staff:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Revokes company membership only. The account and any shop membership/lists are kept.
const deleteEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = Number.isNaN(id) ? null : await findStaffMember(id);
    if (!staff) return res.status(404).json({ error: "Company staff member not found" });
    if (!canActOnStaff(req.user, id, staff.companyMembership)) {
      return res.status(403).json({ error: "You cannot change this staff member" });
    }

    await prisma.companyStaffMembership.update({
      where: { employeeId: id },
      data: { status: "REMOVED", deactivatedAt: new Date() },
    });
    res.json({ id, message: "Company access removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const getEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const employee = Number.isNaN(id)
      ? null
      : await prisma.empolyee.findFirst({
          where: { id, companyMembership: { status: { not: "REMOVED" } } },
          select: staffSelect,
        });
    if (!employee) return res.status(404).json({ error: "Company staff member not found" });
    res.json(formatStaff(employee));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};


const getAllEmployees = async (req, res) => {
  try {
    // Company staff only. Shop employees are listed under Customers → Customer details.
    const employees = await prisma.empolyee.findMany({
      where: { companyMembership: { status: { not: "REMOVED" } } },
      select: staffSelect,
      orderBy: { id: "asc" },
    });

    const employeeIds = employees.map((employee) => employee.id);
    const activitiesByEmployee = new Map();

    if (employeeIds.length > 0) {
      const actionLogs = await prisma.actionLog.findMany({
        where: {
          employeeId: { in: employeeIds },
          actionType: "ADD",
        },
        select: {
          employeeId: true,
          timestamp: true,
        },
      });

      actionLogs.forEach((log) => {
        const date = new Date(log.timestamp).toISOString().split("T")[0];
        const hour = new Date(log.timestamp).getHours();
        const hourKey = `${hour}:00`;

        if (!activitiesByEmployee.has(log.employeeId)) {
          activitiesByEmployee.set(log.employeeId, {});
        }

        const activitiesByDate = activitiesByEmployee.get(log.employeeId);

        if (!activitiesByDate[date]) {
          activitiesByDate[date] = {
            date,
            totalProducts: 0,
            hourlyBreakdown: {}
          };
        }

        activitiesByDate[date].totalProducts += 1;

        if (!activitiesByDate[date].hourlyBreakdown[hourKey]) {
          activitiesByDate[date].hourlyBreakdown[hourKey] = 0;
        }

        activitiesByDate[date].hourlyBreakdown[hourKey] += 1;
      });
    }

    const employeeActivity = employees.map((employee) => {
      const activitiesByDate = activitiesByEmployee.get(employee.id) || {};
      const activities = Object.values(activitiesByDate).map((dateData) => ({
        date: dateData.date,
        totalProducts: dateData.totalProducts,
        hourlyBreakdown: Object.entries(dateData.hourlyBreakdown).map(([hour, count]) => ({
          hour,
          count
        }))
      }));

      return {
        ...formatStaff(employee),
        phone: employee.phoneNo,
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


export { addEmployee, updateEmployee, deleteEmployee, getEmployee, getAllEmployees, grantCompanyAccess };
