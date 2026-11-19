const names: Record<string, [string, string]> = {
  "unit.read": ["ერთეულის ნახვა", "View unit"],
  "member.read": ["წევრების ნახვა", "View members"],
  "workitem.create": ["დავალებების მართვა", "Manage tasks"],
  "workitem.verify": ["შესრულების დადასტურება", "Verify completion"],
  "workitem.read": ["დავალებების ნახვა", "View tasks"],
  "workitem.participate": ["დავალებებში მონაწილეობა", "Participate in tasks"],
  "membership.propose": [
    "წევრობის ცვლილების მოთხოვნა",
    "Propose membership changes",
  ],
  "membership.approve": [
    "წევრობის ცვლილების დამტკიცება",
    "Approve membership changes",
  ],
  "unit.propose": ["ერთეულის შექმნის მოთხოვნა", "Propose units"],
  "unit.approve": ["ერთეულის შექმნის დამტკიცება", "Approve units"],
  "unit.change.propose": [
    "ერთეულის ცვლილების მოთხოვნა",
    "Propose unit changes",
  ],
  "unit.change.approve": [
    "ერთეულის ცვლილების დამტკიცება",
    "Approve unit changes",
  ],
  "decision.read": ["კენჭისყრების ნახვა", "View decisions"],
  "decision.manage": ["კენჭისყრების მართვა", "Manage decisions"],
  "decision.publish": ["კენჭისყრების გამოქვეყნება", "Publish decisions"],
  "decision.vote": ["ხმის მიცემა", "Vote"],
  "qualification.verify": [
    "კვალიფიკაციის დადასტურება",
    "Verify qualifications",
  ],
  "governance.propose": ["დამტკიცების მოთხოვნა", "Submit approval requests"],
  "governance.vote": ["მოთხოვნების შეფასება", "Review requests"],
  "governance.manage": ["დამტკიცების წესების მართვა", "Manage approval policy"],
  "finance.read": ["დაფინანსების ნახვა", "View funding"],
  "finance.record": ["ფინანსური ჩანაწერის მოთხოვნა", "Propose funding records"],
  "finance.approve": [
    "ფინანსური ჩანაწერის დამტკიცება",
    "Approve funding records",
  ],
  "contribution.manage": [
    "ჯილდოების წესების მართვა",
    "Manage recognition rules",
  ],
  "contribution.award": [
    "პირადი ჯილდოს მოთხოვნა",
    "Propose individual recognition",
  ],
  "contribution.read": ["ქულების ნახვა", "View contribution points"],
  "channel.read": ["არხების ნახვა", "View channels"],
  "channel.post": ["არხში გამოქვეყნება", "Post to channels"],
  "channel.manage": ["არხების მართვა", "Manage channels"],
  "channel.moderate": ["არხების მოდერაცია", "Moderate channels"],
  "position.propose": [
    "პოზიციის ცვლილების მოთხოვნა",
    "Propose position definitions",
  ],
  "position.approve": [
    "პოზიციის ცვლილების დამტკიცება",
    "Approve position definitions",
  ],
};
export function positionPermissionLabel(permission: string, language: string) {
  return names[permission]?.[language === "ka" ? 0 : 1] ?? permission;
}
