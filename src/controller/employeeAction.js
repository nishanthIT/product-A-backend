import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon"; // Ensure this package is installed: `npm install luxon`

const prisma = new PrismaClient();

const getHourlyProductAdds = async (req, res) => {
  const { employeeId } = req.params;

  try {
    const currentTime = new Date();

    // Fetch all actions for the day
    const actions = await prisma.actionLog.findMany({
      where: {
        employeeId: parseInt(employeeId, 10),
        timestamp: {
          gte: new Date(currentTime.setHours(0, 0, 0, 0)), // Start of the day
          lte: new Date(), // Current time
        },
        actionType: "ADD", // Only "ADD" actions
      },
    });

    console.log("Fetched Actions:", actions); // Debug fetched data

    // Initialize hourly split for 24 hours
    const hourlySplits = new Array(24).fill(0);

    actions.forEach((action) => {
      const actionTime = new Date(action.timestamp);
      let hour = actionTime.getHours();

      // If after 10 PM, add to 8 AM bucket
      if (hour >= 22) {
        hour = 8;
      } else if (hour < 8) {
        return; // Skip products added outside of 8 AM-10 PM range
      }

      hourlySplits[hour] += 1; // Add to the correct bucket
    });

    // Format response
    const hourly = hourlySplits.map((count, index) => ({
      hourRange: `${index}:00 - ${index + 1}:00`,
      productCount: count,
    }));

    const totals = {
      totalProducts: actions.length,
      weeklyProducts: actions.length, // Replace with actual weekly calculation
      dailyProducts: actions.length, // Replace with actual daily calculation
    };

    res.status(200).json({
      success: true,
      data: {
        hourly,
        totals,
      },
    });
  } catch (error) {
    console.error("Error fetching employee hourly product adds:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { getHourlyProductAdds };
