import { SessionInfo } from "./types/session-info";
import { AppiumCommand } from "./types/appium-command";
import { interceptProxyResponse, routeToCommand, isDashboardCommand } from "./utils";
import { getLogs, startScreenRecording, stopScreenRecording, takeScreenShot } from "./driver-command-executor";
import { CommandParser } from "./command-parser";
import { CommandLogs as commandLogsModel, Session, Logs as LogsTable } from "./models";
import { Op } from "sequelize";
import { pluginLogger } from "./loggers/plugin-logger";
import { logger } from "./loggers/logger";
import * as fs from "fs";
import "reflect-metadata";
import { Container } from "typedi";
import { v4 as uuidv4 } from "uuid";
import { DashboardCommands } from "./dashboard-commands";

const cj = require("circular-json");

const CREATE_SESSION = "createSession";
class SessionManager {
  private lastLogLine = 0;
  private config: any = Container.get("config");
  private dashboardCommands: DashboardCommands;

  constructor(private sessionInfo: SessionInfo, private commandParser: CommandParser, private sessionResponse: any) {
    this.sessionInfo.is_completed = false;
    this.dashboardCommands = new DashboardCommands(sessionInfo);
  }

  public async onCommandRecieved(command: AppiumCommand): Promise<any> {
    if (command.commandName == CREATE_SESSION) {
      return await this.sessionStarted(command);
    } else if (command.commandName == "deleteSession") {
      await this.sessionTerminated(command);
    } else if (command.commandName == "execute" && isDashboardCommand(this.dashboardCommands, command.args[0])) {
      await this.executeCommand(command);
      return true;
    } else if (command.commandName == "proxyReqRes") {
      let promise = interceptProxyResponse(command.args[1]);
      let originalNext = command.next;
      command.next = async () => (await Promise.all([originalNext(), promise]))[1];
      Object.assign(command, {
        ...routeToCommand(command.args),
      });
      logger.info(`Recieved proxyReqRes command for ${command.commandName}`);
    }

    logger.info(`New command recieved ${command.commandName} for session ${this.sessionInfo.session_id}`);
    await this.saveServerLogs(command);
    try {
      command.startTime = new Date();
      let res = await command.next();
      logger.info(`Recieved response for command ${command.commandName} for session ${this.sessionInfo.session_id}`);
      command.endTime = new Date();
      await this.saveCommandLog(command, res);
      return res;
    } catch (err: any) {
      command.endTime = new Date();
      await this.saveCommandLog(command, {
        error: err.error,
        message: err.message,
      });
      logger.error(
        `Error occured while executing ${command.commandName} command ` +
          JSON.stringify({
            error: err.error,
            message: err.message,
          })
      );
      throw err;
    }
  }

  private async sessionStarted(command: AppiumCommand) {
    await Session.create({
      ...this.sessionInfo,
      start_time: new Date(),
    } as any);

    await this.saveCommandLog(command, null);
    await this.initializeScreenShotFolder();
    return await this.startScreenRecording(command.driver);
  }

  private async sessionTerminated(command: AppiumCommand) {
    this.sessionInfo.is_completed = true;
    let videoPath = await this.saveScreenRecording(command.driver);
    let errorCount = await commandLogsModel.count({
      where: {
        session_id: this.sessionInfo.session_id,
        is_error: true,
        command_name: {
          [Op.notIn]: ["findElement", "elementDisplayed"],
        },
      },
    });
    let session = await Session.findOne({
      where: {
        session_id: this.sessionInfo.session_id,
      },
    });

    let updateObject: Partial<Session> = {};
    updateObject.is_completed = true;
    updateObject.end_time = new Date();
    updateObject.video_path = videoPath ? videoPath : null;

    if (!session?.session_status) {
      updateObject.session_status = errorCount > 0 ? "FAILED" : "PASSED";
    }

    if (session?.is_test_passed == null) {
      updateObject.is_test_passed = errorCount > 0 ? false : true;
    }

    await Session.update(updateObject, {
      where: {
        session_id: this.sessionInfo.session_id,
      },
    });
    logger.info(`Session terminated ${this.sessionInfo.session_id}`);
  }

  private async saveServerLogs(command: AppiumCommand) {
    let logs = getLogs(command.driver, this.sessionInfo.session_id, "server");
    let newLogs = logs.slice(this.lastLogLine);
    if (!newLogs.length) {
      return false;
    }
    this.lastLogLine = logs.length;
    await LogsTable.bulkCreate(
      newLogs.map((l: any) => {
        return {
          ...l,
          timestamp: new Date(l.timestamp),
          session_id: this.sessionInfo.session_id,
          log_type: "DEVICE",
        };
      })
    );

    return true;
  }

  private async saveCommandLog(command: AppiumCommand, response: any) {
    if (typeof this.commandParser[command.commandName as keyof CommandParser] == "function") {
      response = command.commandName == CREATE_SESSION ? this.sessionInfo : response;
      let parsedLog: any = await this.commandParser[command.commandName as keyof CommandParser](
        command.driver,
        command.args,
        response
      );
      let screenShotPath = null;
      if (this.config.takeScreenshotsFor.indexOf(command.commandName) >= 0) {
        screenShotPath = `${this.config.screenshotSavePath}/${this.sessionInfo.session_id}/${uuidv4()}.jpg`;
        let screenShotbase64 = await takeScreenShot(command.driver, this.sessionInfo.session_id);
        fs.writeFileSync(screenShotPath, screenShotbase64.value, "base64");
        logger.info(`Screen shot saved for ${command.commandName} command in session ${this.sessionInfo.session_id}`);
      }
      Object.assign(parsedLog, {
        session_id: this.sessionInfo.session_id,
        command_name: command.commandName,
        is_error: response && !!response.error ? true : false,
        screen_shot: screenShotPath,
        start_time: command.startTime,
        end_time: command.endTime,
      });
      try {
        await commandLogsModel.create(parsedLog as any);
      } catch (err) {
        pluginLogger.info(err);
        throw err;
      }
    }
  }

  private async startScreenRecording(driver: any) {
    await startScreenRecording(driver, this.sessionInfo.session_id);
  }

  private async initializeScreenShotFolder() {
    if (!fs.existsSync(`${this.config.screenshotSavePath}/${this.sessionInfo.session_id}`)) {
      fs.mkdirSync(`${this.config.screenshotSavePath}/${this.sessionInfo.session_id}`, { recursive: true });
    }
  }

  private async saveScreenRecording(driver: any) {
    let videoBase64String = await stopScreenRecording(driver, this.sessionInfo.session_id);
    if (videoBase64String.value != "") {
      let outPath = `${this.config.videoSavePath}/${this.sessionInfo.session_id}.mp4`;
      fs.writeFileSync(outPath, videoBase64String.value, "base64");
      logger.info(`Video saved for ${this.sessionInfo.session_id} in ${outPath}`);
      return outPath;
    } else {
      logger.warn(`Video file is empty for session ${this.sessionInfo.session_id}`);
    }
  }

  private async executeCommand(command: AppiumCommand) {
    let scriptName = command.args[0].split(":")[1].trim();
    await (this.dashboardCommands[scriptName as keyof DashboardCommands] as any)(command.args[1]);
  }
}

export { SessionManager };
