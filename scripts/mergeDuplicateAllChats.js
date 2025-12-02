import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function mergeDuplicateAllChats() {
  try {
    console.log('🔧 Merging duplicate ALL Chat groups...\n');

    // Find all "ALL Chat" groups
    const allChats = await prisma.chat.findMany({
      where: {
        name: 'ALL Chat',
        type: 'GROUP'
      },
      include: {
        participants: true,
        messages: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1
        }
      }
    });

    if (allChats.length <= 1) {
      console.log('✅ Only one ALL Chat exists, nothing to merge!');
      return;
    }

    console.log(`Found ${allChats.length} ALL Chat groups:`);
    for (const chat of allChats) {
      console.log(`   - ${chat.id}: ${chat.participants.length} participants, ${chat.messages.length > 0 ? 'has messages' : 'no messages'}`);
    }

    // Keep the one with more activity (more participants or messages)
    const sortedChats = allChats.sort((a, b) => {
      // First, prefer the one with messages
      if (a.messages.length > 0 && b.messages.length === 0) return -1;
      if (a.messages.length === 0 && b.messages.length > 0) return 1;
      // Then prefer the one with more participants
      return b.participants.length - a.participants.length;
    });

    const keepChat = sortedChats[0];
    const deleteChats = sortedChats.slice(1);

    console.log(`\n✅ Keeping: ${keepChat.id} (${keepChat.participants.length} participants)`);
    console.log(`❌ Deleting: ${deleteChats.map(c => c.id).join(', ')}\n`);

    // For each chat to delete
    for (const chat of deleteChats) {
      console.log(`Processing ${chat.id}...`);
      
      // Move messages to the keep chat
      const messageCount = await prisma.message.updateMany({
        where: { chatId: chat.id },
        data: { chatId: keepChat.id }
      });
      console.log(`   ✅ Moved ${messageCount.count} messages`);

      // Delete participants
      await prisma.chatParticipant.deleteMany({
        where: { chatId: chat.id }
      });
      console.log(`   ✅ Deleted participants`);

      // Delete the chat
      await prisma.chat.delete({
        where: { id: chat.id }
      });
      console.log(`   ✅ Deleted chat\n`);
    }

    console.log('✅ Merge complete!');
    console.log(`\n📊 Final ALL Chat:`);
    const finalChat = await prisma.chat.findUnique({
      where: { id: keepChat.id },
      include: {
        participants: true,
        messages: true
      }
    });
    console.log(`   ID: ${finalChat.id}`);
    console.log(`   Participants: ${finalChat.participants.length}`);
    console.log(`   Messages: ${finalChat.messages.length}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

mergeDuplicateAllChats();
