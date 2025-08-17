const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ZEGO Configuration
const ZEGO_CONFIG = {
  APP_ID: process.env.ZEGO_APP_ID,
  SERVER_SECRET: process.env.ZEGO_SERVER_SECRET,
  API_BASE_URL: process.env.ZEGO_API_BASE_URL,
  LLM_URL: process.env.LLM_URL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL
};

// Agent configuration - registered once
let REGISTERED_AGENT_ID = null;

// Generate ZEGO API Signature according to docs
function generateZegoSignature(params) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  
  const signatureParams = {
    ...params,
    AppId: ZEGO_CONFIG.APP_ID,
    SignatureNonce: nonce,
    Timestamp: timestamp,
    SignatureVersion: '2.0'
  };
  
  // Sort parameters and create query string
  const sortedKeys = Object.keys(signatureParams).sort();
  const queryString = sortedKeys
    .map(key => `${key}=${signatureParams[key]}`)
    .join('&');
  
  // Generate HMAC-SHA256 signature
  const signature = crypto
    .createHmac('sha256', ZEGO_CONFIG.SERVER_SECRET)
    .update(queryString)
    .digest('hex');
  
  return {
    ...signatureParams,
    Signature: signature
  };
}

// Make authenticated request to ZEGO API
async function makeZegoRequest(action, bodyParams = {}) {
  const queryParams = generateZegoSignature({ Action: action });
  
  const url = `${ZEGO_CONFIG.API_BASE_URL}?${Object.keys(queryParams)
    .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
    .join('&')}`;
  
  const response = await axios.post(url, bodyParams, {
    headers: {
      'Content-Type': 'application/json'
    }
  });
  
  return response.data;
}

// Register AI Agent with local LLM configuration
async function registerAgent() {
  if (REGISTERED_AGENT_ID) return REGISTERED_AGENT_ID;
  
  const agentId = `agent_${Date.now()}`;
  
  const agentConfig = {
    AgentId: agentId,
    Name: "AI Assistant",
    LLM: {
      Url: ZEGO_CONFIG.LLM_URL,
      ApiKey: ZEGO_CONFIG.LLM_API_KEY,
      Model: ZEGO_CONFIG.LLM_MODEL,
      SystemPrompt: "You are a helpful AI assistant. Respond naturally and conversationally.",
      Temperature: 0.7,
      TopP: 0.9,
      Params: {
        max_tokens: 2048
      }
    },
    TTS: {
      Vendor: "BytePlus",
      VoiceId: "BV700_streaming",
      Speed: 1.0,
      Volume: 1.0
    },
    ASR: {
      Vendor: "BytePlus",
      Language: "en"
    }
  };
  
  console.log('Registering agent with ZEGO...');
  const result = await makeZegoRequest('RegisterAgent', agentConfig);
  
  if (result.Code === 0) {
    REGISTERED_AGENT_ID = agentId;
    console.log(`Agent registered successfully: ${agentId}`);
    return agentId;
  } else {
    throw new Error(`Failed to register agent: ${result.Message}`);
  }
}

// API Endpoints
app.post('/api/start', async (req, res) => {
  try {
    const { room_id, user_id, user_stream_id } = req.body;
    
    // Ensure agent is registered
    const agentId = await registerAgent();
    
    // Create agent instance
    const instanceConfig = {
      AgentId: agentId,
      RoomId: room_id,
      UserId: user_id,
      UserStreamId: user_stream_id || `${user_id}_stream`
    };
    
    console.log('Creating agent instance...');
    const result = await makeZegoRequest('CreateAgentInstance', instanceConfig);
    
    if (result.Code === 0) {
      console.log(`Agent instance created: ${result.Data?.AgentInstanceId}`);
      res.json({
        success: true,
        agentInstanceId: result.Data?.AgentInstanceId,
        agentId: agentId
      });
    } else {
      console.error('Failed to create agent instance:', result);
      res.status(500).json({ error: result.Message || 'Failed to create agent instance' });
    }
  } catch (error) {
    console.error('Start session error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send message to AI agent
app.post('/api/send-message', async (req, res) => {
  try {
    const { agent_instance_id, message } = req.body;
    
    const messageConfig = {
      AgentInstanceId: agent_instance_id,
      Content: message
    };
    
    console.log(`Sending message to agent: ${message}`);
    const result = await makeZegoRequest('SendAgentInstanceLLM', messageConfig);
    
    if (result.Code === 0) {
      res.json({ success: true });
    } else {
      console.error('Failed to send message:', result);
      res.status(500).json({ error: result.Message || 'Failed to send message' });
    }
  } catch (error) {
    console.error('Send message error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stop agent instance
app.post('/api/stop', async (req, res) => {
  try {
    const { agent_instance_id } = req.body;
    
    const stopConfig = {
      AgentInstanceId: agent_instance_id
    };
    
    console.log(`Stopping agent instance: ${agent_instance_id}`);
    const result = await makeZegoRequest('DeleteAgentInstance', stopConfig);
    
    if (result.Code === 0) {
      console.log('Agent instance stopped successfully');
      res.json({ success: true });
    } else {
      console.error('Failed to stop agent instance:', result);
      res.status(500).json({ error: result.Message || 'Failed to stop agent instance' });
    }
  } catch (error) {
    console.error('Stop session error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ZEGO Callbacks endpoint
app.post('/api/callbacks', (req, res) => {
  console.log('ZEGO Callback received:', JSON.stringify(req.body, null, 2));
  
  // Handle different callback types
  const { event_type, data } = req.body;
  
  switch (event_type) {
    case 'agent_started':
      console.log('Agent started:', data);
      break;
    case 'agent_stopped':
      console.log('Agent stopped:', data);
      break;
    case 'llm_response':
      console.log('LLM response received:', data);
      break;
    default:
      console.log('Unknown callback type:', event_type);
  }
  
  res.json({ success: true });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    registeredAgent: !!REGISTERED_AGENT_ID
  });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ZEGO AI Backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Callbacks URL: http://localhost:${PORT}/api/callbacks`);
});