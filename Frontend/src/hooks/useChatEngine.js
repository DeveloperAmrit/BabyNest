import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateResponse } from '../model/model';
import { ragService } from '../services/RAGService';
import { conversationContext } from '../services/ConversationContext';
import { BASE_URL } from "@env";

export const useChatEngine = (isInitialized, context, refreshContext) => {
  const [conversation, setConversation] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const cancellationRef = useRef(0);

  // Load chats on mount
  useEffect(() => {
    const loadChats = async () => {
      try {
        const storedChats = await AsyncStorage.getItem('chat_history');
        if (storedChats) {
          const parsedChats = JSON.parse(storedChats);
          if (Array.isArray(parsedChats)) {
            setConversation(parsedChats);
            // Hydrate context
            parsedChats.forEach(msg => {
              if (msg?.role && msg?.content) {
                conversationContext.addMessage(msg.role, msg.content);
              }
            });
          }
        }
      } catch (error) {
        console.error("Failed to load chats", error);
      }
    };
    loadChats();
  }, []);

  // Sync to storage
  const saveChats = useCallback(async (newConversation) => {
    try {
      await AsyncStorage.setItem('chat_history', JSON.stringify(newConversation));
    } catch (error) {
      console.error("Failed to save chats", error);
    }
  }, []);

  const generateID = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const clearConversation = useCallback(async () => {
    cancellationRef.current += 1; // Block pending responses
    setConversation([]);
    conversationContext.clearConversationHistory();
    await saveChats([]);
  }, [saveChats]);

  const sendMessage = useCallback(async (text, useRAGMode, initializeContext) => {
    if (!text || !text.trim()) return;

    // Ensure context is initialized
    if (!isInitialized) {
      try {
        await initializeContext();
      } catch (error) {
        console.warn('Failed to initialize context:', error);
      }
    }

    const formatTime = () => {
      const now = new Date();
      return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const userMessage = { 
      id: generateID(), 
      role: "user", 
      content: text,
      timestamp: formatTime()
    };
    const cancellationId = cancellationRef.current;
    
    // Add message to conversation context immediately
    conversationContext.addMessage('user', text);
    setIsGenerating(true);

    // We use functional update to ensure we always have the latest state, 
    // even if clearConversation was called just before this.
    setConversation(prev => {
      const newHistory = [...prev, userMessage];
      saveChats(newHistory);
      return newHistory;
    });

    try {
      let response = null;
      let result = null;

      // Prepare the history for the model. 
      // Important: We use the most recent history available in this render cycle plus the new message.
      const updatedConversationForModel = [...conversation, userMessage];

      conversationContext.setUserContext(context);

      // Strategy: RAG -> Backend Agent -> Local LLM
      
      // Step 1: Try RAG if enabled
      if (useRAGMode) {
        try {
          if (conversationContext.hasPendingFollowUp()) {
            if (__DEV__) console.log('🤖 Processing follow-up response with RAG...');
            result = await conversationContext.processFollowUpResponse(text, ragService);
          } else {
            if (__DEV__) console.log('🤖 Processing new query with RAG...');
            result = await ragService.processQuery(text, context);
          }
          
          if (result && typeof result === 'object' && result.message) {
            response = result.message;
            if (__DEV__) console.log('✅ RAG Response received');
          }
        } catch (ragError) {
          console.warn('RAG processing failed:', ragError);
          // Fall through to backend
        }
      }

      // Step 2: Fallback to Backend Agent if no response yet
      if (!response) {
        if (__DEV__) console.log('☁️ Attempting Backend Agent...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for backend

        try {
          const agentResponse = await fetch(`${BASE_URL}/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: text, user_id: "default" }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if (agentResponse.ok) {
            const agentData = await agentResponse.json();
            response = agentData.response;
            if (__DEV__) console.log('✅ Backend Agent Response received');
            result = { message: response, intent: 'backend_fallback', action: null };
          } else {
            throw new Error(`Backend agent failed with ${agentResponse.status}`);
          }
        } catch (backendError) {
          clearTimeout(timeoutId);
          console.warn('Backend fallback failed or timed out:', backendError.message);
          // Fall through to local model
        }
      }

      // Step 3: Fallback to Local Model if still no response
      if (!response) {
        if (__DEV__) console.log('📞 Fallback to local model...');
        try {
          const startTime = Date.now();
          response = await generateResponse(updatedConversationForModel);
          if (__DEV__) {
              const endTime = Date.now();
              console.log(`⏱️ Model Response Latency: ${endTime - startTime}ms`);
          }
          result = { message: response, intent: 'local_llm', action: null };
        } catch (localError) {
          console.error("Local model generation failed:", localError);
          throw new Error("All AI services failed. Please try again later.");
        }
      }

      // Post-processing of result
      if (result && typeof result === 'object') {
        if (result.requiresFollowUp && result.intent && result.partialData && result.missingFields) {
          conversationContext.setPendingFollowUp(
            result.intent,
            result.partialData,
            result.missingFields
          );
        } else {
          conversationContext.clearPendingFollowUp();
        }
      }

      // 🛡️ Cancellation Guard: If the conversation was cleared while thinking, discard the response.
      if (cancellationId !== cancellationRef.current) {
        if (__DEV__) console.log('🚫 AI response blocked: Conversation was cleared.');
        return;
      }

      if (response) {
        const botMessage = { 
          id: generateID(), 
          role: "assistant", 
          content: response,
          timestamp: formatTime()
        };
        setConversation(prev => {
          const newHistory = [...prev, botMessage];
          saveChats(newHistory);
          return newHistory;
        });
        conversationContext.addMessage('assistant', response);
      }

      return result;

    } catch (error) {
      Alert.alert("Error", "Failed to generate response: " + error.message);
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  }, [isInitialized, context, saveChats, conversation]); // conversation added as dependency to avoid stale closure

  return {
    conversation,
    isGenerating,
    sendMessage,
    clearConversation
  };
};
