// page-script.js - Fixed version with proper serialization of WebRTC objects
(function() {
  console.log('Netflix Together page script loaded - FIXED VERSION');
  
  // Create a dedicated namespace that's harder to overwrite
  window.__NETFLIX_TOGETHER = {
    socket: null,
    connected: false,
    roomCode: null,
    isHost: false,
    lastActivity: Date.now()
  };
  
  // Emergency reconnection function - available globally for debugging
  window.netflixTogetherEmergencyReconnect = function() {
    console.log('🚨 EMERGENCY RECONNECTION TRIGGERED 🚨');
    try {
      createRobustConnection('https://netflix-together-server.onrender.com');
      
      // If we have a room code, rejoin it
      if (window.__NETFLIX_TOGETHER.roomCode) {
        setTimeout(() => {
          console.log('Attempting to rejoin room after emergency reconnect:', window.__NETFLIX_TOGETHER.roomCode);
          const socket = window.__NETFLIX_TOGETHER.socket;
          if (socket && socket.connected) {
            socket.emit('join', {
              room: window.__NETFLIX_TOGETHER.roomCode,
              isHost: window.__NETFLIX_TOGETHER.isHost === true
            });
          }
        }, 1000);
      }
      
      return "Reconnection attempt initiated";
    } catch(e) {
      console.error('Emergency reconnection failed:', e);
      return "Failed: " + e.message;
    }
  };

  // Add a global debugging helper
  window.netflixTogetherGetRoomInfo = function() {
    return {
      roomCode: window.__NETFLIX_TOGETHER.roomCode,
      isHost: window.__NETFLIX_TOGETHER.isHost,
      connected: window.__NETFLIX_TOGETHER.connected,
      socketExists: !!window.__NETFLIX_TOGETHER.socket,
      socketConnected: window.__NETFLIX_TOGETHER.socket?.connected || false,
      lastActivity: new Date(window.__NETFLIX_TOGETHER.lastActivity).toLocaleTimeString()
    };
  };
  
  // Core function to create a robust connection
  function createRobustConnection(serverUrl) {
    console.log('🔌 Creating robust socket connection to:', serverUrl);
    
    // Force cleanup any existing connection
    if (window.__NETFLIX_TOGETHER.socket) {
      try {
        console.log('Cleaning up existing connection...');
        window.__NETFLIX_TOGETHER.socket.disconnect();
      } catch(e) {
        console.warn('Error during cleanup:', e);
      }
    }
    
    // Create new connection with aggressive options
    try {
      if (typeof io === 'undefined') {
        throw new Error('Socket.io not loaded! Make sure socket.io.js is injected first.');
      }
      
      console.log('Initializing new socket.io connection...');
      
      // Create connection with multiple fallback options
      const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        timeout: 30000,
        forceNew: true,
        autoConnect: true
      });
      
      // Store in multiple places for redundancy
      window.__NETFLIX_TOGETHER.socket = socket;
      window.socketConnection = socket; // For backward compatibility

      // Double-check connection creation
      if (!window.__NETFLIX_TOGETHER.socket || !window.socketConnection) {
        console.error('❌ Failed to store socket connection!');
      } else {
        console.log('✅ Socket connection stored successfully');
      }
      
      setupRobustEventHandlers(socket);
      return socket;
    } catch(e) {
      console.error('❌ Failed to create socket connection:', e);
      document.dispatchEvent(new CustomEvent('netflix-together-socket-connection-failed', {
        detail: { error: e.toString() }
      }));
      throw e;
    }
  }
  
  // Set up event handlers that can survive reconnections
  function setupRobustEventHandlers(socket) {
    // Core connection events
    socket.on('connect', function() {
      console.log('🟢 CONNECTED! Socket ID:', socket.id);
      window.__NETFLIX_TOGETHER.connected = true;
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      
      // Protect our socket references
      window.__NETFLIX_TOGETHER.socket = socket;
      window.socketConnection = socket;
      
      document.dispatchEvent(new CustomEvent('netflix-together-socket-connected'));
      
      // Automatically rejoin room if we were in one
      if (window.__NETFLIX_TOGETHER.roomCode) {
        console.log('Automatically rejoining room:', window.__NETFLIX_TOGETHER.roomCode);
        socket.emit('join', {
          room: window.__NETFLIX_TOGETHER.roomCode,
          isHost: window.__NETFLIX_TOGETHER.isHost === true
        });
      }
    });
    
    socket.on('connect_error', function(error) {
      console.error('🔴 Connection error:', error);
      window.__NETFLIX_TOGETHER.connected = false;
      document.dispatchEvent(new CustomEvent('netflix-together-socket-error', {
        detail: { message: error.toString() }
      }));
    });
    
    socket.on('disconnect', function(reason) {
      console.log('🔴 Disconnected:', reason);
      window.__NETFLIX_TOGETHER.connected = false;
      document.dispatchEvent(new CustomEvent('netflix-together-disconnected', {
        detail: { reason: reason }
      }));
      
      // Aggressive reconnection
      if (reason !== 'io client disconnect') {
        console.log('Attempting to reconnect automatically...');
        setTimeout(() => {
          if (!window.__NETFLIX_TOGETHER.connected) {
            socket.connect();
          }
        }, 1000);
      }
    });
    
    // Room and messaging events
    socket.on('joined-room', function(data) {
      console.log('🎉 Successfully joined room:', data);
      
      // CRITICAL FIX: Make sure we store the room code for reconnections
      window.__NETFLIX_TOGETHER.roomCode = data.roomCode.toUpperCase();
      window.__NETFLIX_TOGETHER.isHost = data.isHost === true;  // FIXED: Ensure boolean
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      
      // Double-check the room exists
      socket.emit('check-room', data.roomCode, function(response) {
        console.log('Room check response after joining:', response);
        if (!response || !response.exists) {
          console.error('Room should exist but check failed! Retrying join...');
          socket.emit('join', {
            room: data.roomCode,
            isHost: data.isHost === true
          });
        }
      });
      
      document.dispatchEvent(new CustomEvent('netflix-together-joined-room', {
        detail: data
      }));
    });
    
    socket.on('user-joined', function(userId) {
      console.log('👋 User joined:', userId);
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      document.dispatchEvent(new CustomEvent('netflix-together-user-joined', {
        detail: { userId: userId }
      }));
    });
    
    socket.on('user-left', function(userId) {
      console.log('👋 User left:', userId);
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      document.dispatchEvent(new CustomEvent('netflix-together-user-left', {
        detail: { userId: userId }
      }));
    });
    
    // FIXED: Properly handle signal data before dispatchEvent
    socket.on('signal', function(data) {
      console.log('📡 Signal received of type:', data.type);
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      
      // Ensure data is safe to clone before dispatching
      // We need to clone it because WebRTC objects can't be serialized
      try {
        document.dispatchEvent(new CustomEvent('netflix-together-signal-received', {
          detail: data
        }));
      } catch (e) {
        console.error('Failed to dispatch signal event:', e);
        
        // Try to create a simplified version that can be cloned
        if (data.type === 'ice-candidate' && data.candidate) {
          console.log('Simplifying ICE candidate for event dispatch');
          const simplifiedData = {
            type: 'ice-candidate',
            candidate: {
              candidate: data.candidate.candidate,
              sdpMid: data.candidate.sdpMid,
              sdpMLineIndex: data.candidate.sdpMLineIndex,
              usernameFragment: data.candidate.usernameFragment
            }
          };
          
          document.dispatchEvent(new CustomEvent('netflix-together-signal-received', {
            detail: simplifiedData
          }));
        } else if ((data.type === 'offer' || data.type === 'answer') && data.sdp) {
          console.log('Simplifying SDP for event dispatch');
          const simplifiedData = {
            type: data.type,
            sdp: {
              type: data.sdp.type,
              sdp: data.sdp.sdp
            }
          };
          
          document.dispatchEvent(new CustomEvent('netflix-together-signal-received', {
            detail: simplifiedData
          }));
        }
      }
    });
    
    socket.on('chat-message', function(data) {
      console.log('💬 Chat message received:', data);
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      document.dispatchEvent(new CustomEvent('netflix-together-chat-message-received', {
        detail: data
      }));
    });
    
    socket.on('video-control', function(data) {
      console.log('🎬 Video control received:', data);
      window.__NETFLIX_TOGETHER.lastActivity = Date.now();
      document.dispatchEvent(new CustomEvent('netflix-together-video-control-received', {
        detail: data
      }));
    });
    
    socket.on('server-info', function(data) {
      console.log('ℹ️ Server info received:', data);
    });
  }
  
  // Create the handler with more robust methods
  window.netflixTogetherHandler = {
    // Create a connection that persists
    createConnection: function(serverUrl) {
      try {
        createRobustConnection(serverUrl);
        return true;
      } catch(e) {
        console.error('Connection creation failed:', e);
        return false;
      }
    },
    
    // Join a room with robust error handling
    joinRoom: function(roomCode, isHost) {
      console.log('📋 Attempting to join room:', roomCode, 'as host:', isHost);
      
      // CRITICAL FIX: Preserve the original isHost value precisely as a boolean
      const hostFlag = isHost === true;
      console.log('Host flag value (should be boolean):', hostFlag, typeof hostFlag);
      
      // Normalize room code
      roomCode = roomCode.trim().toUpperCase();
      
      // Store room info even before joining
      window.__NETFLIX_TOGETHER.roomCode = roomCode;
      window.__NETFLIX_TOGETHER.isHost = hostFlag;
      
      // Get socket with fallback
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      
      if (socket && socket.connected) {
        console.log('Joining room with connected socket, isHost:', hostFlag);
        
        // Send the join request
        console.log(`CRITICAL: Emitting join event for room ${roomCode}, isHost:`, hostFlag);
        socket.emit('join', {
          room: roomCode,
          isHost: hostFlag
        });
        
        // Force a check after a short delay
        setTimeout(() => {
          socket.emit('check-room', roomCode, function(response) {
            console.log(`Room check response after joining: ${JSON.stringify(response)}`);
            if (response.exists) {
              console.log(`Confirmed in room ${roomCode}`);
            } else {
              console.error(`Failed to join room ${roomCode}`);
              // Try joining again
              socket.emit('join', {
                room: roomCode,
                isHost: hostFlag
              });
            }
          });
        }, 1000);
        
        return true;
      } else {
        console.error('Cannot join room: No connected socket');
        
        // Try to reconnect and then join
        if (socket) {
          console.log('Attempting to reconnect socket before joining room');
          socket.connect();
          
          // Wait for connection and then join
          setTimeout(() => {
            if (socket.connected) {
              console.log('Socket reconnected, now joining room, isHost:', hostFlag);
              socket.emit('join', {
                room: roomCode,
                isHost: hostFlag
              });
            } else {
              console.error('Socket failed to reconnect in time');
              
              // Last resort: create new connection
              try {
                console.log('Creating new connection as last resort');
                const newSocket = createRobustConnection('https://netflix-together-server.onrender.com');
                
                // Wait a bit and then try to join
                setTimeout(() => {
                  if (newSocket && newSocket.connected) {
                    newSocket.emit('join', {
                      room: roomCode,
                      isHost: hostFlag
                    });
                  }
                }, 1000);
              } catch(e) {
                console.error('Last resort connection failed');
              }
            }
          }, 2000);
        }
        return false;
      }
    },
    
    // FIXED: Ensure signal is properly serializable
    sendSignal: function(data) {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (!socket || !socket.connected) {
        console.error('Cannot send signal: No connected socket');
        return false;
      }
      
      // We need to make sure the data is serializable
      try {
        const serializedData = {};
        
        // Handle different signal types
        if (data.type === 'offer' || data.type === 'answer') {
          serializedData.type = data.type;
          
          // Extract just the needed parts from SDP
          if (data.sdp) {
            serializedData.sdp = {
              type: data.sdp.type,
              sdp: data.sdp.sdp
            };
          }
        } else if (data.type === 'ice-candidate') {
          serializedData.type = 'ice-candidate';
          
          // Extract just the needed parts from ICE candidate
          if (data.candidate) {
            serializedData.candidate = {
              candidate: data.candidate.candidate,
              sdpMid: data.candidate.sdpMid,
              sdpMLineIndex: data.candidate.sdpMLineIndex,
              usernameFragment: data.candidate.usernameFragment
            };
          }
        } else {
          // For other types, just copy the data
          Object.assign(serializedData, data);
        }
        
        // Now send the serialized data
        socket.emit('signal', serializedData);
        window.__NETFLIX_TOGETHER.lastActivity = Date.now();
        return true;
      } catch (e) {
        console.error('Error serializing signal data:', e);
        return false;
      }
    },
    
    // Send a chat message with robust error handling
    sendChatMessage: function(message) {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (socket && socket.connected) {
        socket.emit('chat-message', {
          message: message
        });
        window.__NETFLIX_TOGETHER.lastActivity = Date.now();
        return true;
      } else {
        console.error('Cannot send chat: No connected socket');
        return false;
      }
    },
    
    // Send video control with robust error handling
    sendVideoControl: function(action, time) {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (socket && socket.connected) {
        socket.emit('video-control', {
          action: action,
          time: time
        });
        window.__NETFLIX_TOGETHER.lastActivity = Date.now();
        return true;
      } else {
        console.error('Cannot send video control: No connected socket');
        return false;
      }
    },
    
    // Send ping to keep connection alive
    ping: function() {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (socket && socket.connected) {
        socket.emit('ping', (response) => {
          window.__NETFLIX_TOGETHER.lastActivity = Date.now();
        });
        return true;
      }
      return false;
    },
    
    // Leave room and disconnect
    disconnect: function() {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (socket) {
        if (window.__NETFLIX_TOGETHER.roomCode) {
          socket.emit('leave-room');
          window.__NETFLIX_TOGETHER.roomCode = null;
        }
        socket.disconnect();
        window.__NETFLIX_TOGETHER.connected = false;
        return true;
      }
      return false;
    },
    
    // Check room existence
    checkRoom: function(roomCode) {
      const socket = window.__NETFLIX_TOGETHER.socket || window.socketConnection;
      if (socket && socket.connected) {
        console.log('Checking room existence:', roomCode);
        socket.emit('check-room', roomCode, function(response) {
          console.log('Room check response:', response);
        });
        return true;
      }
      return false;
    },
    
    // Improved connection status checking
    checkConnectionStatus: function() {
      console.log('------ CONNECTION STATUS CHECK ------');
      console.log('NETFLIX_TOGETHER namespace exists:', !!window.__NETFLIX_TOGETHER);
      
      if (window.__NETFLIX_TOGETHER) {
        console.log('Socket exists:', !!window.__NETFLIX_TOGETHER.socket);
        console.log('Connected status:', window.__NETFLIX_TOGETHER.connected);
        console.log('Room code:', window.__NETFLIX_TOGETHER.roomCode);
        console.log('Is host:', window.__NETFLIX_TOGETHER.isHost);
        console.log('Last activity:', new Date(window.__NETFLIX_TOGETHER.lastActivity).toLocaleTimeString());
        
        const inactivityTime = Date.now() - window.__NETFLIX_TOGETHER.lastActivity;
        console.log('Inactivity time:', Math.round(inactivityTime/1000), 'seconds');
        
        // Socket exists but says it's not connected - verify actual connection
        if (window.__NETFLIX_TOGETHER.socket) {
          const socket = window.__NETFLIX_TOGETHER.socket;
          console.log('Socket ID:', socket.id);
          console.log('Socket connected:', socket.connected);
          console.log('Socket disconnected:', socket.disconnected);
          
          // If room code exists, check with server
          if (window.__NETFLIX_TOGETHER.roomCode && socket.connected) {
            socket.emit('check-room', window.__NETFLIX_TOGETHER.roomCode, function(response) {
              console.log('Room status check:', response);
              
              // If room exists but we're not properly in it, rejoin
              if (response && response.exists && 
                window.__NETFLIX_TOGETHER.roomCode && 
                response.usersCount < 2) {
                // Double-check if we need to rejoin
                socket.emit('join', {
                  room: window.__NETFLIX_TOGETHER.roomCode,
                  isHost: window.__NETFLIX_TOGETHER.isHost === true
                });
              }
            });
          }
          
          // Mismatch between our tracking and socket's state
          if (window.__NETFLIX_TOGETHER.connected !== socket.connected) {
            console.log('Fixing connection state tracking mismatch');
            window.__NETFLIX_TOGETHER.connected = socket.connected;
          }
          
          // Reconnect if needed
          if (!socket.connected) {
            console.log('💥 Socket disconnected, attempting to reconnect...');
            try {
              socket.connect();
              
              // If still not connected after a second, create new connection
              setTimeout(() => {
                if (!socket.connected) {
                  console.log('Socket failed to reconnect, creating new connection');
                  createRobustConnection('https://netflix-together-server.onrender.com');
                }
              }, 1000);
            } catch(e) {
              console.error('Reconnection failed:', e);
              
              // Create new connection as fallback
              try {
                createRobustConnection('https://netflix-together-server.onrender.com');
              } catch(err) {
                console.error('Failed to create new connection:', err);
              }
            }
          } else if (inactivityTime > 60000) { // 1 minute of inactivity
            console.log('Long inactivity detected, sending ping');
            socket.emit('ping', (response) => {
              window.__NETFLIX_TOGETHER.lastActivity = Date.now();
            });
          }
        } else {
          console.log('No socket object, creating new connection');
          try {
            createRobustConnection('https://netflix-together-server.onrender.com');
          } catch(e) {
            console.error('Failed to create new connection:', e);
          }
        }
      } else {
        console.error('NETFLIX_TOGETHER namespace missing!');
        
        // Recreate the namespace and connection
        console.log('Recreating namespace and connection');
        window.__NETFLIX_TOGETHER = {
          socket: null,
          connected: false,
          roomCode: null,
          isHost: false,
          lastActivity: Date.now()
        };
        
        try {
          createRobustConnection('https://netflix-together-server.onrender.com');
        } catch(e) {
          console.error('Failed to create connection after namespace recreation:', e);
        }
      }
      console.log('-------------------------------------');
    }
  };
  
  // Set up message listener for content script communication
  window.addEventListener('message', function(event) {
    // Only accept messages from our window
    if (event.source !== window) return;
    
    const data = event.data;
    if (!data || !data.type || !data.type.startsWith('NETFLIX_TOGETHER_')) return;
    
    console.log('Page script received message:', data.type);
    
    try {
      switch (data.type) {
        case 'NETFLIX_TOGETHER_CREATE_CONNECTION':
          const success = window.netflixTogetherHandler.createConnection(data.serverUrl);
          window.postMessage({
            type: 'NETFLIX_TOGETHER_CONNECTION_CREATED',
            success: success
          }, '*');
          break;
          
        case 'NETFLIX_TOGETHER_JOIN_ROOM':
          // CRITICAL FIX: Preserve the isHost parameter exactly as received
          const isHost = data.isHost === true;
          const roomCode = data.roomCode.trim().toUpperCase();
          
          console.log('Joining room with normalized code:', roomCode, 'isHost:', isHost, 'type:', typeof isHost);
          
          // Store for debugging recovery
          window.lastJoinAttempt = {
            roomCode: roomCode,
            isHost: isHost,
            time: new Date().toLocaleTimeString()
          };
          
          // Join room
          window.netflixTogetherHandler.joinRoom(roomCode, isHost);
          break;
          
        case 'NETFLIX_TOGETHER_SIGNAL':
          window.netflixTogetherHandler.sendSignal(data.signal);
          break;
          
        case 'NETFLIX_TOGETHER_CHAT_MESSAGE':
          window.netflixTogetherHandler.sendChatMessage(data.message);
          break;
          
        case 'NETFLIX_TOGETHER_VIDEO_CONTROL':
          window.netflixTogetherHandler.sendVideoControl(data.action, data.time);
          break;
          
        case 'NETFLIX_TOGETHER_PING':
          window.netflixTogetherHandler.ping();
          break;
          
        case 'NETFLIX_TOGETHER_DISCONNECT':
          window.netflixTogetherHandler.disconnect();
          break;
          
        case 'NETFLIX_TOGETHER_CHECK_ROOM':
          window.netflixTogetherHandler.checkRoom(data.roomCode);
          break;
          
        case 'NETFLIX_TOGETHER_EMERGENCY_RECOVERY':
          window.emergencyRoomRecovery(data.roomCode, data.isHost);
          break;
      }
    } catch(e) {
      console.error('Error handling message:', e);
    }
  });
  
  // Force immediate room check function for debugging
  window.forceJoinRoom = function(roomCode, asHost) {
    console.log('🚨 FORCING ROOM JOIN:', roomCode, 'as host:', asHost);
    if (!roomCode) {
      console.error('No room code provided for forced join');
      return false;
    }
    
    roomCode = roomCode.trim().toUpperCase();
    
    // Store info
    window.__NETFLIX_TOGETHER.roomCode = roomCode;
    window.__NETFLIX_TOGETHER.isHost = asHost === true;
    
    // Get socket reference
    const socket = window.__NETFLIX_TOGETHER.socket;
    if (socket && socket.connected) {
      console.log('Sending forced join request to server for room:', roomCode);
      // Direct API call to server
      socket.emit('join', {
        room: roomCode,
        isHost: asHost === true
      });
      
      // Verify after delay
      setTimeout(() => {
        socket.emit('check-room', roomCode, (response) => {
          console.log('FORCED JOIN VERIFICATION:', response);
          if (response && response.exists) {
            console.log('✅ Successfully joined room:', roomCode);
          } else {
            console.log('❌ Failed to join room:', roomCode);
          }
        });
      }, 1000);
      return true;
    } else {
      console.error('Cannot force join: No connected socket');
      return false;
    }
  };
  
  // Emergency recovery function
  window.emergencyRoomRecovery = function(roomCode, isHost) {
    roomCode = roomCode || window.__NETFLIX_TOGETHER.roomCode || window.currentRoomCode;
    isHost = isHost !== undefined ? isHost === true : (window.__NETFLIX_TOGETHER.isHost === true || window.currentIsHost === true);
    
    if (!roomCode) {
      console.error('No room code available for recovery');
      return false;
    }
    
    console.log('🚑 EMERGENCY ROOM RECOVERY FOR:', roomCode, 'isHost:', isHost);
    
    // First, ensure socket connection
    if (!window.__NETFLIX_TOGETHER.socket || !window.__NETFLIX_TOGETHER.socket.connected) {
      console.log('Reconnecting socket first...');
      window.netflixTogetherEmergencyReconnect();
      
      // Wait for connection, then join
      setTimeout(() => {
        if (window.__NETFLIX_TOGETHER.socket && window.__NETFLIX_TOGETHER.socket.connected) {
          window.__NETFLIX_TOGETHER.socket.emit('join', {
            room: roomCode,
            isHost: isHost
          });
          
          console.log('Emergency join request sent!');
        } else {
          console.error('Failed to reconnect for emergency recovery');
        }
      }, 2000);
    } else {
      // Socket is connected, just join
      window.__NETFLIX_TOGETHER.socket.emit('join', {
        room: roomCode,
        isHost: isHost
      });
      console.log('Emergency join request sent!');
    }
    
    return true;
  };
  
  // Initial connection status check
  setTimeout(() => {
    window.netflixTogetherHandler.checkConnectionStatus();
  }, 3000);
  
  // Set up regular connection checking
  setInterval(() => {
    if (window.netflixTogetherHandler) {
      window.netflixTogetherHandler.checkConnectionStatus();
    }
  }, 30000); // Check every 30 seconds
  
  // Notify that the page script is ready
  document.dispatchEvent(new CustomEvent('netflix-together-page-script-loaded'));
  console.log('Netflix Together page script ready - FIXED VERSION');
})();