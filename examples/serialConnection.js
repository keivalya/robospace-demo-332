// examples/serialConnection.js
export class RobotSerialConnection {
    constructor() {
      this.port = null;
      this.writer = null;
      this.reader = null;
      this.isConnected = false;
    }
  
    async connect(baudRate = 1000000) {
      try {
        this.port = await navigator.serial.requestPort();
        await this.port.open({ baudRate });
        
        const textEncoder = new TextEncoderStream();
        const writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
        this.writer = textEncoder.writable.getWriter();
        
        this.isConnected = true;
        return true;
      } catch (error) {
        console.error('Failed to connect:', error);
        return false;
      }
    }
  
    async disconnect() {
      if (this.writer) {
        await this.writer.close();
      }
      if (this.port) {
        await this.port.close();
      }
      this.isConnected = false;
    }
  
    async sendJointPositions(positions) {
      if (!this.isConnected) return;
      
      // Convert positions to servo commands
      // This will depend on your specific servo protocol
      const commands = this.convertToServoCommands(positions);
      
      try {
        await this.writer.write(commands);
      } catch (error) {
        console.error('Failed to send positions:', error);
      }
    }
  
    convertToServoCommands(positions) {
      // Implement servo-specific protocol here
      // For Feetech servos, you'd implement the SCS protocol
      // This is a simplified example
      let commands = '';
      positions.forEach((pos, index) => {
        // Convert radians to servo position (0-4096 for Feetech)
        const servoPos = Math.round((pos + Math.PI) * 4096 / (2 * Math.PI));
        commands += `SERVO${index}:${servoPos}\n`;
      });
      return commands;
    }
  }