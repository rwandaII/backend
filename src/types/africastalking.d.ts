declare module 'africastalking' {
  interface SmsSendArgs {
    to: string[];
    message: string;
    from?: string;
  }

  interface SmsClient {
    send(args: SmsSendArgs): Promise<unknown>;
  }

  interface AfricasTalkingClient {
    SMS: SmsClient;
  }

  function africastalking(options: { apiKey: string; username: string }): AfricasTalkingClient;

  export = africastalking;
}
