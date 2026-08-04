"use client";

import { Flex, Box } from "@chakra-ui/react";
import { ChatInterface } from "@/components/ChatInterface";

export default function Home() {
  return (
    <Flex direction="column" h="100dvh" bg="white">
      <Box as="main" flex={1} minH={0} overflow="hidden">
        <ChatInterface />
      </Box>
    </Flex>
  );
}
