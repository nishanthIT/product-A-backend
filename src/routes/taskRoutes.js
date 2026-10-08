import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature, requireShopMembershipForEmployees } from '../middleware/authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';
import { userRoom } from '../services/realtime.js';

const router = express.Router();
const prisma = new PrismaClient();

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = [isAuthenticated, requireShopFeature(SHOP_FEATURES.TASKS)];
// Starting/completing your own assignment is recording work, not editing the task.
const taskProgressAuth = [isAuthenticated, requireShopFeature(SHOP_FEATURES.TASKS, 'write')];

// Customer-only middleware (Customers are shop owners/admins)
const requireCustomer = (req, res, next) => {
  if (req.user.userType !== 'CUSTOMER') {
    return res.status(403).json({ error: 'Shop owner access required' });
  }
  next();
};

// Helper to get user's shop ID
const getUserShopId = async (userId, userType) => {
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return customer?.shopId;
  } else if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return employee?.shopId;
  }
  return null;
};

// ===== ADMIN ENDPOINTS =====

// GET /api/tasks - Get all tasks for the shop (Admin)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { status, employeeId } = req.query;

    const whereClause = { shopId };
    if (status) whereClause.status = status;

    const tasks = await prisma.task.findMany({
      where: whereClause,
      include: {
        createdBy: {
          select: { id: true, name: true }
        },
        assignments: {
          include: {
            employee: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      },
      orderBy: [
        { status: 'asc' },
        { dueDate: 'asc' },
        { createdAt: 'desc' }
      ]
    });

    // If employeeId filter, filter tasks that have that employee assigned
    let filteredTasks = tasks;
    if (employeeId) {
      filteredTasks = tasks.filter(task => 
        task.assignments.some(a => a.employeeId === parseInt(employeeId))
      );
    }

    // Format response
    const formattedTasks = filteredTasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      status: task.status,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      assignments: task.assignments.map(a => ({
        id: a.id,
        employee: a.employee,
        isStarted: a.isStarted,
        startedAt: a.startedAt,
        isCompleted: a.isCompleted,
        completedAt: a.completedAt
      })),
      // Calculate overall completion
      completedCount: task.assignments.filter(a => a.isCompleted).length,
      totalAssignments: task.assignments.length
    }));

    res.json({ success: true, tasks: formattedTasks });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// POST /api/tasks - Create a new task (Admin only)
router.post('/', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { title, description, dueDate, employeeIds } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    if (!employeeIds || employeeIds.length === 0) {
      return res.status(400).json({ error: 'At least one employee must be assigned' });
    }

    const uniqueEmployeeIds = [...new Set(
      employeeIds
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id))
    )];

    if (uniqueEmployeeIds.length === 0) {
      return res.status(400).json({ error: 'At least one valid employee must be assigned' });
    }

    const shopId = await getUserShopId(customerId, req.user.userType);
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify all employees are ACTIVE in this shop and allowed to use tasks
    const assignable = await prisma.shopEmployeeMembership.count({
      where: {
        employeeId: { in: uniqueEmployeeIds },
        shopId,
        status: 'ACTIVE',
        permissions: { has: SHOP_FEATURES.TASKS }
      }
    });

    if (assignable !== uniqueEmployeeIds.length) {
      return res.status(400).json({ error: 'Some employees are not in your shop or do not have task access' });
    }

    // Create task with assignments
    const task = await prisma.task.create({
      data: {
        title,
        description: description || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        shopId,
        createdById: customerId,
        assignments: {
          create: uniqueEmployeeIds.map(empId => ({
            employeeId: empId
          }))
        }
      },
      include: {
        shop: {
          select: { id: true, name: true }
        },
        createdBy: {
          select: { id: true, name: true }
        },
        assignments: {
          include: {
            employee: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      }
    });

    // Send task assignment notifications without affecting task creation outcome.
    try {
      if (req.io) {
        const dueDateIso = task.dueDate ? new Date(task.dueDate).toISOString() : null;
        const assignedBy = task.createdBy?.name || 'Shop Owner';
        const shopName = task.shop?.name || null;

        for (const assignment of task.assignments) {
          const employeeId = assignment.employee?.id;
          if (!employeeId) continue;

          req.io.to(userRoom('EMPLOYEE', employeeId)).emit('task_assigned', {
            type: 'task_assigned',
            title: 'New Task Assigned',
            message: `You have been assigned a new task:\n\"${task.title}\"\nTap to view the task.`,
            taskId: task.id,
            taskName: task.title,
            assignedBy,
            shopName,
            dueDate: dueDateIso,
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (notificationError) {
      console.error('Task created but notification dispatch failed:', notificationError);
    }

    res.status(201).json({ 
      success: true, 
      message: 'Task created successfully',
      task 
    });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PUT /api/tasks/:id - Update a task (Admin only)
router.put('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const taskId = req.params.id;
    const { title, description, dueDate, status, employeeIds } = req.body;

    const shopId = await getUserShopId(customerId, req.user.userType);
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify task exists and belongs to this shop
    const existingTask = await prisma.task.findFirst({
      where: { id: taskId, shopId }
    });

    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Build update data
    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
    if (status !== undefined) updateData.status = status;

    // Assignment diff: existing rows (and their progress) are kept, even for since-deactivated
    // employees; only newly added employees must be ACTIVE members of this shop.
    let assignmentOps = [];
    if (employeeIds !== undefined) {
      const wanted = [...new Set(employeeIds.map((id) => parseInt(id, 10)).filter(Number.isInteger))];
      const existing = await prisma.taskAssignment.findMany({ where: { taskId }, select: { employeeId: true } });
      const existingIds = new Set(existing.map((a) => a.employeeId));
      const added = wanted.filter((id) => !existingIds.has(id));
      const removed = [...existingIds].filter((id) => !wanted.includes(id));

      if (added.length > 0) {
        const activeMembers = await prisma.shopEmployeeMembership.count({
          where: { employeeId: { in: added }, shopId, status: 'ACTIVE', permissions: { has: SHOP_FEATURES.TASKS } }
        });
        if (activeMembers !== added.length) {
          return res.status(400).json({ error: 'Some employees are not in your shop or do not have task access' });
        }
      }
      assignmentOps = [
        ...(removed.length ? [prisma.taskAssignment.deleteMany({ where: { taskId, employeeId: { in: removed } } })] : []),
        ...(added.length ? [prisma.taskAssignment.createMany({ data: added.map((employeeId) => ({ taskId, employeeId })) })] : []),
      ];
    }

    await prisma.$transaction([
      prisma.task.update({ where: { id: taskId }, data: updateData }),
      ...assignmentOps,
    ]);

    // Fetch updated task
    const updatedTask = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        createdBy: {
          select: { id: true, name: true }
        },
        assignments: {
          include: {
            employee: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      }
    });

    res.json({ 
      success: true, 
      message: 'Task updated successfully',
      task: updatedTask 
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /api/tasks/:id - Delete a task (Admin only)
router.delete('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const taskId = req.params.id;

    const shopId = await getUserShopId(customerId, req.user.userType);
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify task exists and belongs to this shop
    const existingTask = await prisma.task.findFirst({
      where: { id: taskId, shopId }
    });

    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await prisma.task.delete({
      where: { id: taskId }
    });

    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ===== EMPLOYEE ENDPOINTS =====

// GET /api/tasks/my-tasks - Get tasks assigned to current employee
router.get('/my-tasks', authenticateToken, requireShopMembershipForEmployees, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    if (userType !== 'EMPLOYEE') {
      return res.status(403).json({ error: 'This endpoint is for employees only' });
    }

    const assignments = await prisma.taskAssignment.findMany({
      where: { employeeId: userId, task: { shopId: req.user.shopId } },
      include: {
        task: {
          include: {
            createdBy: {
              select: { id: true, name: true }
            }
          }
        }
      },
      orderBy: [
        { isCompleted: 'asc' },
        { task: { dueDate: 'asc' } }
      ]
    });

    const tasks = assignments.map(a => ({
      id: a.task.id,
      title: a.task.title,
      description: a.task.description,
      dueDate: a.task.dueDate,
      status: a.task.status,
      createdBy: a.task.createdBy,
      createdAt: a.task.createdAt,
      assignmentId: a.id,
      isStarted: a.isStarted,
      startedAt: a.startedAt,
      isCompleted: a.isCompleted,
      completedAt: a.completedAt
    }));

    res.json({ success: true, tasks });
  } catch (error) {
    console.error('Error fetching my tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// PUT /api/tasks/start/:assignmentId - Mark task as started/in-progress (Employee)
router.put('/start/:assignmentId', taskProgressAuth, requireShopMembershipForEmployees, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const assignmentId = req.params.assignmentId;
    const { isStarted } = req.body;

    if (userType !== 'EMPLOYEE') {
      return res.status(403).json({ error: 'Only employees can start tasks' });
    }

    // Verify assignment belongs to this employee in their current shop
    const assignment = await prisma.taskAssignment.findFirst({
      where: { 
        id: assignmentId,
        employeeId: userId,
        task: { shopId: req.user.shopId }
      },
      include: {
        task: true
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    // Update assignment
    const updatedAssignment = await prisma.taskAssignment.update({
      where: { id: assignmentId },
      data: {
        isStarted: isStarted !== false,
        startedAt: isStarted !== false ? new Date() : null
      },
      include: {
        task: {
          include: {
            createdBy: {
              select: { id: true, name: true }
            }
          }
        },
        employee: {
          select: { id: true, name: true }
        }
      }
    });

    // Check if any assignments are started or completed
    const allAssignments = await prisma.taskAssignment.findMany({
      where: { taskId: assignment.taskId }
    });

    const allCompleted = allAssignments.every(a => a.isCompleted);
    const anyStartedOrCompleted = allAssignments.some(a => a.isStarted || a.isCompleted);

    let newStatus = 'PENDING';
    if (allCompleted) {
      newStatus = 'COMPLETED';
    } else if (anyStartedOrCompleted) {
      newStatus = 'IN_PROGRESS';
    }

    await prisma.task.update({
      where: { id: assignment.taskId },
      data: { status: newStatus }
    });

    res.json({ 
      success: true, 
      message: isStarted !== false ? 'Task started' : 'Task paused',
      assignment: updatedAssignment
    });
  } catch (error) {
    console.error('Error starting task:', error);
    res.status(500).json({ error: 'Failed to start task' });
  }
});

// PUT /api/tasks/complete/:assignmentId - Mark task as completed (Employee)
router.put('/complete/:assignmentId', taskProgressAuth, requireShopMembershipForEmployees, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const assignmentId = req.params.assignmentId;
    const { isCompleted } = req.body;

    if (userType !== 'EMPLOYEE') {
      return res.status(403).json({ error: 'Only employees can complete tasks' });
    }

    // Verify assignment belongs to this employee in their current shop
    const assignment = await prisma.taskAssignment.findFirst({
      where: { 
        id: assignmentId,
        employeeId: userId,
        task: { shopId: req.user.shopId }
      },
      include: {
        task: true
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    // Repeat taps / retries must not rewrite the original completion time.
    if (isCompleted !== false && assignment.isCompleted) {
      return res.json({
        success: true,
        message: 'Task already completed',
        alreadyCompleted: true,
        taskStatus: assignment.task.status,
        assignment,
      });
    }

    // Update assignment - also set isStarted true if completing
    const updateData = {
      isCompleted: isCompleted !== false,
      completedAt: isCompleted !== false ? new Date() : null
    };
    
    // When completing, also mark as started if not already
    if (isCompleted !== false) {
      updateData.isStarted = true;
      updateData.startedAt = assignment.startedAt || new Date();
    }
    
    const updatedAssignment = await prisma.taskAssignment.update({
      where: { id: assignmentId },
      data: updateData,
      include: {
        task: {
          include: {
            createdBy: {
              select: { id: true, name: true }
            }
          }
        },
        employee: {
          select: { id: true, name: true }
        }
      }
    });

    // Check if all assignments are completed, update task status
    const allAssignments = await prisma.taskAssignment.findMany({
      where: { taskId: assignment.taskId }
    });

    const allCompleted = allAssignments.every(a => a.isCompleted);
    const anyStartedOrCompleted = allAssignments.some(a => a.isStarted || a.isCompleted);

    let newStatus = 'PENDING';
    if (allCompleted) {
      newStatus = 'COMPLETED';
    } else if (anyStartedOrCompleted) {
      newStatus = 'IN_PROGRESS';
    }

    await prisma.task.update({
      where: { id: assignment.taskId },
      data: { status: newStatus }
    });

    res.json({ 
      success: true, 
      message: isCompleted !== false ? 'Task marked as completed' : 'Task marked as incomplete',
      alreadyCompleted: false,
      taskStatus: newStatus,
      assignment: updatedAssignment
    });
  } catch (error) {
    console.error('Error completing task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

export default router;
