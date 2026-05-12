use clap::{Args, Subcommand};

#[derive(Debug, Args)]
pub(crate) struct SkillsCommand {
    #[command(subcommand)]
    command: SkillsSubcommand,
}

#[derive(Debug, Subcommand)]
enum SkillsSubcommand {
    /// List configured Reborn skills.
    List(SkillsListCommand),
}

#[derive(Debug, Args)]
struct SkillsListCommand {
    /// Show extra status details.
    #[arg(short, long)]
    verbose: bool,

    /// Output skills as JSON.
    #[arg(long)]
    json: bool,
}

impl SkillsCommand {
    pub(crate) fn execute(self) -> anyhow::Result<()> {
        match self.command {
            SkillsSubcommand::List(command) => command.execute(),
        }
    }
}

impl SkillsListCommand {
    fn execute(self) -> anyhow::Result<()> {
        if self.json {
            let mut output = serde_json::json!({
                "configured": 0,
                "skills": [],
                "status": "not-wired",
                "v1_state": "not-used",
            });
            if self.verbose {
                output["details"] = serde_json::json!([
                    "Reborn skill catalog is not wired yet",
                    "v1 skill discovery is intentionally not read"
                ]);
            }
            println!("{}", output);
            return Ok(());
        }

        println!("IronClaw Reborn skills");
        println!("configured: 0");
        println!("status: not-wired");
        println!("v1_state: not-used");

        if self.verbose {
            println!("detail: Reborn skill catalog is not wired yet");
            println!("detail: v1 skill discovery is intentionally not read");
        }

        Ok(())
    }
}
